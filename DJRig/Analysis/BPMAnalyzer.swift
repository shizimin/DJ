import AVFoundation
import Foundation

/// オフラインの BPM / ビートグリッド推定。
///
/// 手順:
/// 1. 3 バンドのエネルギー差分（スペクトラルフラックス相当）でオンセット包絡線を作る
/// 2. 移動平均を引いて半波整流し、ドラムの立ち上がりだけを残す
/// 3. 60–200 BPM に対応するラグで自己相関を取り、放物線補間でピークを精密化
/// 4. 85–175 BPM に収まるようオクターブ補正
/// 5. 選んだ周期でコムフィルタを走らせ、1 拍目の位相を決める
enum BPMAnalyzer {
    /// オンセット包絡線のホップ長（フレーム）。44.1kHz で約 344Hz の包絡線になる。
    private static let hopFrames = 128
    private static let minBPM = 60.0
    private static let maxBPM = 200.0

    static func analyze(url: URL) throws -> TrackAnalysis {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let sampleRate = format.sampleRate
        guard sampleRate > 0, file.length > AVAudioFramePosition(hopFrames * 8) else { return .unknown }

        let envelope = try onsetEnvelope(file: file, format: format)
        guard envelope.count > 64 else { return .unknown }

        let envelopeRate = sampleRate / Double(hopFrames)
        let cleaned = emphasize(envelope, windowSamples: Int(envelopeRate * 0.4))

        guard let (period, confidence) = dominantPeriod(cleaned, envelopeRate: envelopeRate) else {
            return .unknown
        }

        let bpm = foldToMusicalRange(60.0 / (period / envelopeRate))
        let foldedPeriod = 60.0 / bpm * envelopeRate
        let firstBeat = beatPhase(cleaned, period: foldedPeriod) / envelopeRate

        return TrackAnalysis(bpm: (bpm * 100).rounded() / 100,
                             firstBeat: firstBeat,
                             confidence: min(1, confidence))
    }

    // MARK: - 1. オンセット包絡線

    private static func onsetEnvelope(file: AVAudioFile, format: AVAudioFormat) throws -> [Float] {
        let sampleRate = format.sampleRate
        let channelCount = Int(format.channelCount)
        let chunkFrames: AVAudioFrameCount = 65_536
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return [] }

        // 低域 / 中域 / 高域。中域はバンドパスとして低域を引いて作る。
        let alphaLow = Float(1 - exp(-2 * Double.pi * 150 / sampleRate))
        let alphaMid = Float(1 - exp(-2 * Double.pi * 2_000 / sampleRate))
        var lowState: Float = 0
        var midState: Float = 0

        var envelope: [Float] = []
        envelope.reserveCapacity(Int(file.length) / hopFrames + 1)

        var previous = SIMD3<Float>(repeating: 0)
        var accumulator = SIMD3<Float>(repeating: 0)
        var framesInHop = 0
        let scale = 1 / Float(max(1, channelCount))

        while file.framePosition < file.length {
            buffer.frameLength = 0
            try file.read(into: buffer, frameCount: chunkFrames)
            let frames = Int(buffer.frameLength)
            if frames == 0 { break }
            guard let channels = buffer.floatChannelData else { break }

            for frame in 0..<frames {
                var mono: Float = 0
                for channel in 0..<channelCount {
                    mono += channels[channel][frame]
                }
                mono *= scale

                lowState += alphaLow * (mono - lowState)
                midState += alphaMid * (mono - midState)
                let low = lowState
                let mid = midState - lowState
                let high = mono - midState

                accumulator += SIMD3<Float>(abs(low), abs(mid), abs(high))
                framesInHop += 1

                if framesInHop >= hopFrames {
                    let energy = accumulator / Float(framesInHop)
                    let flux = energy - previous
                    // 半波整流: エネルギーが増えたときだけ拾う。
                    let rectified = max(flux, SIMD3<Float>(repeating: 0))
                    // 高域に重みを置くとハイハット / スネアの粒が立ってグリッドが安定する。
                    envelope.append(rectified.x * 1.0 + rectified.y * 1.2 + rectified.z * 1.5)
                    previous = energy
                    accumulator = SIMD3<Float>(repeating: 0)
                    framesInHop = 0
                }
            }
        }
        return envelope
    }

    // MARK: - 2. 移動平均を引く

    private static func emphasize(_ envelope: [Float], windowSamples: Int) -> [Float] {
        let window = max(3, windowSamples)
        guard envelope.count > window else { return envelope }

        var prefix: [Float] = Array(repeating: 0, count: envelope.count + 1)
        for index in 0..<envelope.count {
            prefix[index + 1] = prefix[index] + envelope[index]
        }

        var result = [Float](repeating: 0, count: envelope.count)
        let half = window / 2
        for index in 0..<envelope.count {
            let lower = max(0, index - half)
            let upper = min(envelope.count, index + half)
            let mean = (prefix[upper] - prefix[lower]) / Float(upper - lower)
            result[index] = max(0, envelope[index] - mean)
        }
        return result
    }

    // MARK: - 3. 自己相関

    /// 返り値は（包絡線サンプル単位の周期, 信頼度）。
    private static func dominantPeriod(_ envelope: [Float], envelopeRate: Double) -> (Double, Double)? {
        let minLag = Int((60.0 / maxBPM * envelopeRate).rounded())
        let maxLag = Int((60.0 / minBPM * envelopeRate).rounded())
        guard minLag > 1, maxLag > minLag, envelope.count > maxLag * 2 else { return nil }

        var scores = [Double](repeating: 0, count: maxLag + 1)
        let count = envelope.count

        for lag in minLag...maxLag {
            var sum: Double = 0
            var index = 0
            let limit = count - lag
            while index < limit {
                sum += Double(envelope[index]) * Double(envelope[index + lag])
                index += 1
            }
            // 比較対象の数で割って、長いラグが不利にならないようにする。
            scores[lag] = sum / Double(limit)
        }

        var bestLag = minLag
        for lag in minLag...maxLag where scores[lag] > scores[bestLag] {
            bestLag = lag
        }
        let peak = scores[bestLag]
        guard peak > 0 else { return nil }

        let mean = scores[minLag...maxLag].reduce(0, +) / Double(maxLag - minLag + 1)
        let confidence = mean > 0 ? (peak / mean - 1) / 2 : 0

        // 放物線補間でラグを小数精度にする。
        var refined = Double(bestLag)
        if bestLag > minLag, bestLag < maxLag {
            let before = scores[bestLag - 1]
            let after = scores[bestLag + 1]
            let denominator = before - 2 * peak + after
            if abs(denominator) > .ulpOfOne {
                refined += 0.5 * (before - after) / denominator
            }
        }
        return (refined, max(0, confidence))
    }

    // MARK: - 4. オクターブ補正

    private static func foldToMusicalRange(_ bpm: Double) -> Double {
        var value = bpm
        guard value > 0 else { return 0 }
        while value < 85 { value *= 2 }
        while value > 175 { value /= 2 }
        return value
    }

    // MARK: - 5. 位相（1 拍目）

    /// 周期 `period` のコムフィルタを全位相で走らせ、最もエネルギーが乗る位置を返す。
    private static func beatPhase(_ envelope: [Float], period: Double) -> Double {
        guard period >= 2, envelope.count > Int(period) * 2 else { return 0 }
        let periodInt = Int(period.rounded())
        var bestOffset = 0
        var bestScore = -Double.infinity

        for offset in 0..<periodInt {
            var score: Double = 0
            var position = Double(offset)
            while position < Double(envelope.count) {
                let index = Int(position.rounded())
                if index < envelope.count {
                    score += Double(envelope[index])
                    // 隣接サンプルも少し拾って、グリッドのわずかなズレを許容する。
                    if index > 0 { score += Double(envelope[index - 1]) * 0.5 }
                    if index + 1 < envelope.count { score += Double(envelope[index + 1]) * 0.5 }
                }
                position += period
            }
            if score > bestScore {
                bestScore = score
                bestOffset = offset
            }
        }
        return Double(bestOffset)
    }
}

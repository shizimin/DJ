import AVFoundation
import Foundation

/// 波形 1 本分のデータ。`low` / `high` は帯域別のエネルギーで、
/// Rekordbox 風の色分け波形に使う。
struct WaveformBin: Hashable, Codable, Sendable {
    var peak: Float
    var rms: Float
    var low: Float
    var high: Float

    static let zero = WaveformBin(peak: 0, rms: 0, low: 0, high: 0)
}

enum WaveformGenerator {
    /// ファイル全体を走査して `binCount` 本の波形にまとめる。バックグラウンドで呼ぶこと。
    static func generate(url: URL, binCount: Int = 4_000) throws -> [WaveformBin] {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let totalFrames = file.length
        guard totalFrames > 0, binCount > 0 else { return [] }

        let framesPerBin = max(1, Int(totalFrames) / binCount)
        let chunkFrames: AVAudioFrameCount = 65_536
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkFrames) else { return [] }

        // 1 次 IIR で低域 / 高域を分ける。位相は気にしない（表示用のため）。
        let sampleRate = format.sampleRate
        let alphaLow = 1 - exp(-2 * Double.pi * 200 / sampleRate)
        let alphaHigh = 1 - exp(-2 * Double.pi * 4_000 / sampleRate)
        var lowState: Float = 0
        var highState: Float = 0

        var bins: [WaveformBin] = []
        bins.reserveCapacity(binCount + 1)

        var binPeak: Float = 0
        var binSquareSum: Float = 0
        var binLowSum: Float = 0
        var binHighSum: Float = 0
        var binFrames = 0

        while file.framePosition < totalFrames {
            buffer.frameLength = 0
            try file.read(into: buffer, frameCount: chunkFrames)
            let frames = Int(buffer.frameLength)
            if frames == 0 { break }
            guard let channels = buffer.floatChannelData else { break }
            let channelCount = Int(format.channelCount)
            let scale = 1 / Float(max(1, channelCount))

            for frame in 0..<frames {
                var mono: Float = 0
                for channel in 0..<channelCount {
                    mono += channels[channel][frame]
                }
                mono *= scale

                lowState += Float(alphaLow) * (mono - lowState)
                highState += Float(alphaHigh) * (mono - highState)
                let high = mono - highState

                binPeak = max(binPeak, abs(mono))
                binSquareSum += mono * mono
                binLowSum += abs(lowState)
                binHighSum += abs(high)
                binFrames += 1

                if binFrames >= framesPerBin {
                    bins.append(WaveformBin(peak: binPeak,
                                            rms: (binSquareSum / Float(binFrames)).squareRoot(),
                                            low: binLowSum / Float(binFrames),
                                            high: binHighSum / Float(binFrames)))
                    binPeak = 0
                    binSquareSum = 0
                    binLowSum = 0
                    binHighSum = 0
                    binFrames = 0
                }
            }
        }

        if binFrames > 0 {
            bins.append(WaveformBin(peak: binPeak,
                                    rms: (binSquareSum / Float(binFrames)).squareRoot(),
                                    low: binLowSum / Float(binFrames),
                                    high: binHighSum / Float(binFrames)))
        }

        return normalized(bins)
    }

    /// ピークが 1.0 になるよう正規化する。低域 / 高域も同じ係数で揃える。
    private static func normalized(_ bins: [WaveformBin]) -> [WaveformBin] {
        let maxPeak = bins.reduce(Float(0)) { max($0, $1.peak) }
        let maxLow = bins.reduce(Float(0)) { max($0, $1.low) }
        let maxHigh = bins.reduce(Float(0)) { max($0, $1.high) }
        guard maxPeak > 0 else { return bins }
        let peakScale = 1 / maxPeak
        let lowScale = maxLow > 0 ? 1 / maxLow : 0
        let highScale = maxHigh > 0 ? 1 / maxHigh : 0
        return bins.map {
            WaveformBin(peak: $0.peak * peakScale,
                        rms: $0.rms * peakScale,
                        low: $0.low * lowScale,
                        high: $0.high * highScale)
        }
    }
}

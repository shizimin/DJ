import CryptoKit
import Foundation
import Observation
import os

/// 解析結果（BPM + 波形）のディスクキャッシュ。
/// 同じ曲を読み込み直すたびに数秒待たされないようにする。
enum AnalysisCache {
    private static let version = 2
    private static let log = Logger(subsystem: "com.example.DJRig", category: "AnalysisCache")

    private struct Entry: Codable {
        var version: Int
        var analysis: TrackAnalysis
        var waveform: Data
    }

    private static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Analysis", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    static func key(for url: URL) -> String {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attributes?[.size] as? Int) ?? 0
        let seed = "\(url.lastPathComponent)|\(size)"
        let digest = SHA256.hash(data: Data(seed.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func load(key: String) -> (TrackAnalysis, [WaveformBin])? {
        let url = directory.appendingPathComponent("\(key).json")
        guard let data = try? Data(contentsOf: url),
              let entry = try? JSONDecoder().decode(Entry.self, from: data),
              entry.version == version else { return nil }
        return (entry.analysis, unpack(entry.waveform))
    }

    static func save(key: String, analysis: TrackAnalysis, waveform: [WaveformBin]) {
        let entry = Entry(version: version, analysis: analysis, waveform: pack(waveform))
        let url = directory.appendingPathComponent("\(key).json")
        do {
            try JSONEncoder().encode(entry).write(to: url, options: .atomic)
        } catch {
            log.error("cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // 波形は本数が多いので Float32 の生バイト列にまとめる（JSON 配列だと肥大化する）。
    private static func pack(_ bins: [WaveformBin]) -> Data {
        var data = Data(capacity: bins.count * 16)
        for bin in bins {
            for value in [bin.peak, bin.rms, bin.low, bin.high] {
                withUnsafeBytes(of: value.bitPattern.littleEndian) { data.append(contentsOf: $0) }
            }
        }
        return data
    }

    private static func unpack(_ data: Data) -> [WaveformBin] {
        let count = data.count / 16
        guard count > 0 else { return [] }
        var bins: [WaveformBin] = []
        bins.reserveCapacity(count)
        let bytes = [UInt8](data)
        func float(at offset: Int) -> Float {
            var pattern: UInt32 = 0
            for index in 0..<4 {
                pattern |= UInt32(bytes[offset + index]) << (8 * UInt32(index))
            }
            return Float(bitPattern: pattern)
        }
        for index in 0..<count {
            let base = index * 16
            bins.append(WaveformBin(peak: float(at: base),
                                    rms: float(at: base + 4),
                                    low: float(at: base + 8),
                                    high: float(at: base + 12)))
        }
        return bins
    }
}

/// 曲の解析をバックグラウンドで回し、進行状況を UI に出す。
@MainActor
@Observable
final class AnalysisService {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "Analysis")

    /// 解析中のトラック ID。
    private(set) var inProgress: Set<UUID> = []

    func isAnalyzing(_ track: Track) -> Bool { inProgress.contains(track.id) }

    /// キャッシュがあれば即座に、なければ解析して返す。
    func analysis(for track: Track, url: URL) async -> (TrackAnalysis, [WaveformBin]) {
        let cacheKey = AnalysisCache.key(for: url)
        if let cached = AnalysisCache.load(key: cacheKey) {
            return cached
        }

        inProgress.insert(track.id)
        defer { inProgress.remove(track.id) }

        let result = await Task.detached(priority: .userInitiated) { () -> (TrackAnalysis, [WaveformBin]) in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let waveform = try WaveformGenerator.generate(url: url)
                let analysis = try BPMAnalyzer.analyze(url: url)
                return (analysis, waveform)
            } catch {
                Self.log.error("analysis failed: \(error.localizedDescription, privacy: .public)")
                return (.unknown, [])
            }
        }.value

        if result.0.isUsable || !result.1.isEmpty {
            AnalysisCache.save(key: cacheKey, analysis: result.0, waveform: result.1)
        }
        return result
    }
}

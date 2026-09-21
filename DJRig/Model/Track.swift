import Foundation

/// 解析結果（BPM とビートグリッドの原点）。
struct TrackAnalysis: Hashable, Codable {
    /// 推定 BPM。
    var bpm: Double
    /// 1 拍目の位置（秒）。ビートグリッドは `firstBeat + n * 60 / bpm`。
    var firstBeat: TimeInterval
    /// 0...1。自己相関ピークの鋭さ。低い場合は UI 上で警告を出す。
    var confidence: Double

    static let unknown = TrackAnalysis(bpm: 0, firstBeat: 0, confidence: 0)

    var isUsable: Bool { bpm > 0 }

    /// 指定時刻の直前にあるビートの位置。
    func beat(atOrBefore time: TimeInterval) -> TimeInterval? {
        guard isUsable else { return nil }
        let period = 60.0 / bpm
        let n = floor((time - firstBeat) / period)
        return firstBeat + n * period
    }

    /// 指定時刻のビート内位相（0...1）。
    func phase(at time: TimeInterval) -> Double {
        guard isUsable else { return 0 }
        let period = 60.0 / bpm
        let raw = (time - firstBeat) / period
        return raw - floor(raw)
    }
}

/// デッキに載せられる曲。ローカルファイルと Apple Music を 1 つの型で扱う。
struct Track: Identifiable, Hashable, Codable {
    enum Origin: String, Hashable, Codable {
        /// AVAudioEngine で完全にミックスできる音源（Files / iTunes ファイル共有から取り込んだもの）。
        case localFile
        /// MusicKit 経由。DRM のため再生制御のみで、音声処理はできない。
        case appleMusic
    }

    var id: UUID = UUID()
    var title: String
    var artist: String
    var album: String = ""
    var duration: TimeInterval = 0
    var origin: Origin

    /// `.localFile` のときのセキュリティスコープ付きブックマーク。
    var bookmark: Data?
    /// `.localFile` の表示用ファイル名。
    var fileName: String?
    /// `.appleMusic` のときの `MusicItemID` の生値。
    var appleMusicID: String?
    var artworkURL: URL?

    var analysis: TrackAnalysis?

    /// ミキサーに通せる音源かどうか。Apple Music は `false`。
    var isMixable: Bool { origin == .localFile }

    var displaySubtitle: String {
        album.isEmpty ? artist : "\(artist) — \(album)"
    }
}

extension TimeInterval {
    /// `m:ss` 表記。
    var asClock: String {
        guard isFinite, self >= 0 else { return "-:--" }
        let total = Int(rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

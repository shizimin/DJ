import AVFoundation
import Foundation
import Observation
import os

/// ミックス可能な音源（ローカルファイル）のライブラリ。
///
/// 取り込み経路は 2 つ:
/// - Files アプリから選択 → `Documents/Music` にコピー（既定。安定して扱える）
/// - 「元の場所のまま参照」→ セキュリティスコープ付きブックマークを保存
///
/// `UIFileSharingEnabled` を有効にしてあるので、Finder / Files アプリから
/// `Documents/Music` に直接ドロップしたファイルも起動時に拾う。
@MainActor
@Observable
final class LocalLibrary {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "LocalLibrary")

    private(set) var tracks: [Track] = []
    private(set) var lastError: String?

    private static let supportedExtensions: Set<String> = [
        "mp3", "m4a", "aac", "wav", "aif", "aiff", "caf", "flac", "alac", "mp4"
    ]

    static var musicDirectory: URL {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Music", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private static var indexURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("library.json")
    }

    init() {
        load()
        scanMusicDirectory()
    }

    // MARK: - 取り込み

    /// ドキュメントピッカーから受け取った URL を取り込む。
    /// - Parameter copyIntoApp: `true` なら `Documents/Music` にコピーする。
    func importFiles(_ urls: [URL], copyIntoApp: Bool = true) async {
        for url in urls {
            do {
                if copyIntoApp {
                    try await importByCopying(url)
                } else {
                    try await importByReference(url)
                }
            } catch {
                lastError = "\(url.lastPathComponent): \(error.localizedDescription)"
                Self.log.error("import failed: \(error.localizedDescription, privacy: .public)")
            }
        }
        save()
    }

    private func importByCopying(_ url: URL) async throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let destination = Self.uniqueDestination(for: url.lastPathComponent)
        try FileManager.default.copyItem(at: url, to: destination)
        var track = try await makeTrack(from: destination)
        track.fileName = destination.lastPathComponent
        track.bookmark = nil
        appendIfNew(track)
    }

    private func importByReference(_ url: URL) async throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        var track = try await makeTrack(from: url)
        track.bookmark = try url.bookmarkData()
        track.fileName = url.lastPathComponent
        appendIfNew(track)
    }

    /// `Documents/Music` を走査して、まだ登録されていないファイルを追加する。
    func scanMusicDirectory() {
        let directory = Self.musicDirectory
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        let known = Set(tracks.compactMap { $0.bookmark == nil ? $0.fileName : nil })
        let newNames = names.filter {
            Self.supportedExtensions.contains(($0 as NSString).pathExtension.lowercased()) && !known.contains($0)
        }
        guard !newNames.isEmpty else { return }

        Task {
            for name in newNames {
                let url = directory.appendingPathComponent(name)
                do {
                    var track = try await makeTrack(from: url)
                    track.fileName = name
                    appendIfNew(track)
                } catch {
                    Self.log.error("scan failed for \(name, privacy: .public)")
                }
            }
            save()
        }
    }

    private func appendIfNew(_ track: Track) {
        let duplicate = tracks.contains {
            $0.fileName == track.fileName && $0.bookmark == track.bookmark
        }
        guard !duplicate else { return }
        tracks.append(track)
        tracks.sort { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    // MARK: - メタデータ

    private func makeTrack(from url: URL) async throws -> Track {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        let metadata = try await asset.load(.commonMetadata)

        func string(for key: AVMetadataKey) async -> String? {
            guard let item = metadata.first(where: { $0.commonKey == key }) else { return nil }
            return try? await item.load(.stringValue)
        }

        let title = await string(for: .commonKeyTitle) ?? url.deletingPathExtension().lastPathComponent
        let artist = await string(for: .commonKeyArtist) ?? "Unknown Artist"
        let album = await string(for: .commonKeyAlbumName) ?? ""

        return Track(title: title,
                     artist: artist,
                     album: album,
                     duration: duration.isFinite ? duration : 0,
                     origin: .localFile)
    }

    // MARK: - 解決

    /// デッキに渡す実 URL。参照取り込みの場合はブックマークを解決する。
    func resolveURL(for track: Track) -> URL? {
        if let bookmark = track.bookmark {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: bookmark,
                                     bookmarkDataIsStale: &stale) else { return nil }
            if stale, let refreshed = try? url.bookmarkData(),
               let index = tracks.firstIndex(where: { $0.id == track.id }) {
                tracks[index].bookmark = refreshed
                save()
            }
            return url
        }
        guard let fileName = track.fileName else { return nil }
        let url = Self.musicDirectory.appendingPathComponent(fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - 編集

    func remove(_ track: Track, deleteFile: Bool = false) {
        if deleteFile, track.bookmark == nil, let url = resolveURL(for: track) {
            try? FileManager.default.removeItem(at: url)
        }
        tracks.removeAll { $0.id == track.id }
        save()
    }

    func updateAnalysis(_ analysis: TrackAnalysis, for trackID: UUID) {
        guard let index = tracks.firstIndex(where: { $0.id == trackID }) else { return }
        tracks[index].analysis = analysis
        save()
    }

    // MARK: - 永続化

    private func load() {
        guard let data = try? Data(contentsOf: Self.indexURL),
              let decoded = try? JSONDecoder().decode([Track].self, from: data) else { return }
        tracks = decoded
    }

    private func save() {
        do {
            try JSONEncoder().encode(tracks).write(to: Self.indexURL, options: .atomic)
        } catch {
            Self.log.error("library save failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func uniqueDestination(for fileName: String) -> URL {
        let directory = musicDirectory
        var candidate = directory.appendingPathComponent(fileName)
        var counter = 1
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent("\(base)-\(counter).\(ext)")
            counter += 1
        }
        return candidate
    }
}

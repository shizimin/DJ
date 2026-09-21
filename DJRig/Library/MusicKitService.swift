import Foundation
import MusicKit
import Observation
import os

/// Apple Music（MusicKit）へのアクセス。
///
/// できること: 認証、カタログ / ライブラリ検索、プレイリスト一覧、再生制御。
/// できないこと: 音声サンプルの取得。DRM のため `AVAudioEngine` には通せない。
/// 詳しくは `docs/APPLE_MUSIC.md`。
@MainActor
@Observable
final class MusicKitService {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "MusicKit")

    enum Scope: String, CaseIterable, Identifiable {
        case library = "ライブラリ"
        case catalog = "カタログ"
        var id: String { rawValue }
    }

    private(set) var authorizationStatus: MusicAuthorization.Status = MusicAuthorization.currentStatus
    private(set) var subscription: MusicSubscription?
    private(set) var songs: [Song] = []
    private(set) var playlists: [Playlist] = []
    private(set) var isSearching = false
    private(set) var lastError: String?

    var scope: Scope = .library
    var searchTerm: String = ""

    /// カタログ（ストリーミング）の曲を再生できる状態か。
    var canPlayCatalogContent: Bool {
        subscription?.canPlayCatalogContent ?? false
    }

    var isAuthorized: Bool { authorizationStatus == .authorized }

    // MARK: - 認証

    func requestAuthorization() async {
        authorizationStatus = await MusicAuthorization.request()
        if isAuthorized {
            await refreshSubscription()
            await loadPlaylists()
        }
    }

    func observeSubscription() async {
        for await update in MusicSubscription.subscriptionUpdates {
            subscription = update
        }
    }

    private func refreshSubscription() async {
        do {
            subscription = try await MusicSubscription.current
        } catch {
            Self.log.error("subscription lookup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - 検索

    func search() async {
        let term = searchTerm.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isAuthorized else {
            lastError = "Apple Music へのアクセスが許可されていません。"
            return
        }
        guard !term.isEmpty else {
            songs = []
            return
        }

        isSearching = true
        lastError = nil
        defer { isSearching = false }

        do {
            switch scope {
            case .catalog:
                var request = MusicCatalogSearchRequest(term: term, types: [Song.self])
                request.limit = 25
                songs = Array(try await request.response().songs)
            case .library:
                var request = MusicLibrarySearchRequest(term: term, types: [Song.self])
                request.limit = 25
                songs = Array(try await request.response().songs)
            }
        } catch {
            lastError = error.localizedDescription
            Self.log.error("search failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - プレイリスト

    func loadPlaylists() async {
        guard isAuthorized else { return }
        do {
            var request = MusicLibraryRequest<Playlist>()
            request.limit = 100
            playlists = Array(try await request.response().items)
        } catch {
            Self.log.error("playlist load failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// プレイリストの中身を曲だけに絞って返す（ミュージックビデオは除外）。
    func songs(in playlist: Playlist) async -> [Song] {
        do {
            let detailed = try await playlist.with([.tracks])
            return (detailed.tracks ?? []).compactMap { entry -> Song? in
                if case .song(let song) = entry { return song }
                return nil
            }
        } catch {
            Self.log.error("playlist tracks failed: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    // MARK: - 変換

    /// MusicKit の `Song` をアプリ内の `Track` に落とす。`origin` は常に `.appleMusic`。
    static func makeTrack(from song: Song) -> Track {
        Track(title: song.title,
              artist: song.artistName,
              album: song.albumTitle ?? "",
              duration: song.duration ?? 0,
              origin: .appleMusic,
              appleMusicID: song.id.rawValue,
              artworkURL: song.artwork?.url(width: 200, height: 200))
    }
}

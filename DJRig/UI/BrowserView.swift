import MusicKit
import SwiftUI
import UniformTypeIdentifiers

struct BrowserView: View {
    enum Tab: String, CaseIterable, Identifiable {
        case local = "ローカル"
        case appleMusic = "Apple Music"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var model
    @State private var tab: Tab = .local
    @State private var showingImporter = false

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 260)

                Spacer()

                if tab == .local {
                    Button {
                        showingImporter = true
                    } label: {
                        Label("曲を追加", systemImage: "plus")
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.bordered)
                }
            }

            Group {
                switch tab {
                case .local: localList
                case .appleMusic: AppleMusicBrowser()
                }
            }
        }
        .padding(12)
        .panel()
        .fileImporter(isPresented: $showingImporter,
                      allowedContentTypes: [.audio, .mp3, .mpeg4Audio, .wav, .aiff],
                      allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                Task { await model.library.importFiles(urls) }
            case .failure(let error):
                model.statusMessage = error.localizedDescription
            }
        }
    }

    // MARK: - ローカル

    private var localList: some View {
        Group {
            if model.library.tracks.isEmpty {
                emptyLocalState
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(model.library.tracks) { track in
                            LocalTrackRow(track: track)
                        }
                    }
                }
            }
        }
    }

    private var emptyLocalState: some View {
        VStack(spacing: 10) {
            Image(systemName: "waveform.badge.plus")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Theme.textSecondary)
            Text("ミックスできる曲がありません")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("「曲を追加」から音源ファイルを取り込むか、\nFinder / Files アプリで DJRig の Documents/Music に入れてください。")
                .font(.system(size: 11))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct LocalTrackRow: View {
    @Environment(AppModel.self) private var model
    let track: Track

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "music.note")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 1) {
                Text(track.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(track.displaySubtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 6)

            if let analysis = track.analysis, analysis.isUsable {
                Text(String(format: "%.1f", analysis.bpm))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
            } else if model.analysis.isAnalyzing(track) {
                ProgressView().controlSize(.mini)
            }

            Text(track.duration.asClock)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.textSecondary)

            ForEach(DeckID.allCases) { deckID in
                Button {
                    Task { await model.load(track, into: deckID) }
                } label: {
                    Text(deckID.rawValue)
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 24)
                }
                .buttonStyle(.plain)
                .background(Theme.accent(for: deckID).opacity(0.22),
                            in: RoundedRectangle(cornerRadius: 5))
                .foregroundStyle(Theme.accent(for: deckID))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Theme.panelRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
        .contextMenu {
            Button("ライブラリから削除", role: .destructive) {
                model.library.remove(track)
            }
            Button("ファイルごと削除", role: .destructive) {
                model.library.remove(track, deleteFile: true)
            }
        }
    }
}

// MARK: - Apple Music

struct AppleMusicBrowser: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var musicKit = model.musicKit

        Group {
            switch musicKit.authorizationStatus {
            case .authorized:
                authorizedContent
            case .notDetermined:
                permissionPrompt(message: "Apple Music のライブラリを読み込むには許可が必要です。",
                                 action: "アクセスを許可")
            case .denied, .restricted:
                permissionPrompt(message: "Apple Music へのアクセスが拒否されています。\n設定 App > プライバシーとセキュリティ > メディアと Apple Music から許可してください。",
                                 action: "もう一度試す")
            @unknown default:
                permissionPrompt(message: "Apple Music の状態を確認できません。", action: "再試行")
            }
        }
    }

    private func permissionPrompt(message: String, action: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "music.note.house")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(Theme.appleMusic)
            Text(message)
                .font(.system(size: 12))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.textSecondary)
            Button(action) {
                Task { await model.musicKit.requestAuthorization() }
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.appleMusic)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var authorizedContent: some View {
        @Bindable var musicKit = model.musicKit

        return VStack(spacing: 8) {
            HStack(spacing: 8) {
                Picker("", selection: $musicKit.scope) {
                    ForEach(MusicKitService.Scope.allCases) { scope in
                        Text(scope.rawValue).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 180)

                TextField("曲名 / アーティスト", text: $musicKit.searchTerm)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await model.musicKit.search() } }

                Button("検索") {
                    Task { await model.musicKit.search() }
                }
                .buttonStyle(.bordered)
            }

            if musicKit.scope == .catalog && !musicKit.canPlayCatalogContent {
                Label("Apple Music のサブスクリプションがないため、カタログの曲は再生できません。",
                      systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let error = musicKit.lastError {
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if musicKit.isSearching {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(musicKit.songs) { song in
                            AppleMusicSongRow(song: song)
                        }
                    }
                }
            }
        }
    }
}

struct AppleMusicSongRow: View {
    @Environment(AppModel.self) private var model
    let song: Song

    var body: some View {
        HStack(spacing: 10) {
            if let artwork = song.artwork {
                ArtworkImage(artwork, width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                RoundedRectangle(cornerRadius: 4)
                    .fill(Theme.panelRaised)
                    .frame(width: 30, height: 30)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(song.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(song.artistName)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 6)

            Text((song.duration ?? 0).asClock)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.textSecondary)

            Button {
                Task { await model.loadAppleMusic(song) }
            } label: {
                Text("AM デッキ")
                    .font(.system(size: 10, weight: .bold))
                    .padding(.horizontal, 8)
                    .frame(height: 24)
            }
            .buttonStyle(.plain)
            .background(Theme.appleMusic.opacity(0.22), in: RoundedRectangle(cornerRadius: 5))
            .foregroundStyle(Theme.appleMusic)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Theme.panelRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }
}

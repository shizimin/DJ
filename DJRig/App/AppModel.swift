import Foundation
import MusicKit
import Observation
import QuartzCore
import os

/// アプリ全体の状態をまとめる。表示用の値を毎フレーム更新するティッカーもここが持つ。
@MainActor
@Observable
final class AppModel {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "AppModel")

    let engine = DJAudioEngine()
    let library = LocalLibrary()
    let musicKit = MusicKitService()
    let appleMusic = AppleMusicDeck()
    let transition = AutoTransitionController()
    let analysis = AnalysisService()

    /// ロード中のデッキ（スピナー表示用）。
    private(set) var loadingDecks: Set<DeckID> = []
    var statusMessage: String?

    /// マスターテンポの基準デッキ。SYNC はこのデッキに合わせる。
    var syncMaster: DeckID = .a

    @ObservationIgnored private var displayLink: CADisplayLink?
    @ObservationIgnored private var proxy: DisplayLinkProxy?

    // MARK: - ライフサイクル

    func start() {
        AudioSessionManager.activate()
        engine.start()
        transition.configure(engine: engine, appleMusic: appleMusic)
        startTicker()
        Task { await musicKit.observeSubscription() }
    }

    func stop() {
        stopTicker()
        engine.stop()
        AudioSessionManager.deactivate()
    }

    private func startTicker() {
        guard displayLink == nil else { return }
        let proxy = DisplayLinkProxy { [weak self] in
            self?.tick()
        }
        let link = CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.fire))
        // 60Hz で十分。ProMotion で 120Hz 回して電池を食う必要はない。
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.proxy = proxy
        self.displayLink = link
    }

    private func stopTicker() {
        displayLink?.invalidate()
        displayLink = nil
        proxy = nil
    }

    private func tick() {
        engine.deckA.refreshPlayhead()
        engine.deckB.refreshPlayhead()
        appleMusic.refresh()
        transition.tick()
    }

    // MARK: - ロード

    func load(_ track: Track, into deckID: DeckID) async {
        guard track.isMixable else {
            statusMessage = "Apple Music の曲はミキサーに通せません。Apple Music デッキに送ってください。"
            return
        }
        guard let url = library.resolveURL(for: track) else {
            statusMessage = "\(track.title) のファイルが見つかりません。"
            return
        }

        loadingDecks.insert(deckID)
        defer { loadingDecks.remove(deckID) }

        let (result, waveform) = await analysis.analysis(for: track, url: url)
        library.updateAnalysis(result, for: track.id)

        var resolved = track
        resolved.analysis = result

        do {
            try engine.load(track: resolved, url: url, waveform: waveform, into: deckID)
            statusMessage = nil
            if !result.isUsable {
                statusMessage = "\(track.title): BPM を検出できませんでした。手動で設定してください。"
            }
        } catch {
            statusMessage = "読み込みに失敗しました: \(error.localizedDescription)"
            Self.log.error("load failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func loadAppleMusic(_ song: Song) async {
        await appleMusic.load(song: song)
        if let error = appleMusic.lastError {
            statusMessage = "Apple Music: \(error)"
        }
    }

    func isLoading(_ deckID: DeckID) -> Bool { loadingDecks.contains(deckID) }

    // MARK: - 同期

    func sync(_ deckID: DeckID) {
        let target = engine.deck(deckID)
        if deckID == syncMaster {
            // マスター自身の SYNC は Apple Music デッキに合わせる意味にする。
            guard appleMusic.manualBPM > 0, target.analysis.isUsable else { return }
            target.tempoRatio = appleMusic.manualBPM / target.analysis.bpm
            return
        }
        target.sync(to: engine.deck(syncMaster))
    }

    func clearStatus() { statusMessage = nil }
}

/// `CADisplayLink` は ObjC のターゲットを要求するので、薄いプロキシを挟む。
private final class DisplayLinkProxy: NSObject {
    private let handler: () -> Void

    init(handler: @escaping () -> Void) {
        self.handler = handler
    }

    @objc func fire() {
        handler()
    }
}

import Foundation
import Observation

/// Apple Music → ローカルデッキ の自動つなぎ。
///
/// Apple Music 側は音量を操作できないため、**フェードはローカルデッキ側だけで作る**。
/// 動作は次のとおり:
///
/// 1. Apple Music の曲が `cutTime` に近づく
/// 2. `cutTime - fadeLength` でローカルデッキを再生開始し、フェーダーを 0 → 1 に上げる
/// 3. `cutTime`（直前の拍に吸着）で Apple Music を一時停止する
///
/// 逆方向（ローカル → Apple Music）も同じ仕組みで、ローカル側をフェードアウトさせる。
@MainActor
@Observable
final class AutoTransitionController {
    enum Direction: String, CaseIterable, Identifiable {
        case appleMusicToDeck = "Apple Music → デッキ"
        case deckToAppleMusic = "デッキ → Apple Music"
        var id: String { rawValue }
    }

    enum Phase: Equatable {
        case idle
        case armed(at: TimeInterval)
        case running(progress: Double)
        case finished
    }

    private(set) var phase: Phase = .idle

    var direction: Direction = .appleMusicToDeck
    /// つなぎに使う小節数（4 拍 = 1 小節）。
    var fadeBars: Int = 8
    /// 受け側 / 送り側のローカルデッキ。
    var localDeckID: DeckID = .b

    @ObservationIgnored private weak var engine: DJAudioEngine?
    @ObservationIgnored private weak var appleMusic: AppleMusicDeck?
    @ObservationIgnored private var cutTime: TimeInterval = 0
    @ObservationIgnored private var fadeLength: TimeInterval = 0
    @ObservationIgnored private var startedFade = false

    func configure(engine: DJAudioEngine, appleMusic: AppleMusicDeck) {
        self.engine = engine
        self.appleMusic = appleMusic
    }

    var isArmed: Bool {
        if case .idle = phase { return false }
        if case .finished = phase { return false }
        return true
    }

    /// つなぎの開始位置を「Apple Music の現在位置から `afterBars` 小節後」に予約する。
    func arm(afterBars: Int = 16) {
        guard let appleMusic, appleMusic.manualBPM > 0 else { return }
        let beatSeconds = 60 / appleMusic.manualBPM
        fadeLength = beatSeconds * 4 * Double(fadeBars)

        let raw = appleMusic.playbackTime + beatSeconds * 4 * Double(afterBars)
        cutTime = snapToDownbeat(raw, analysis: appleMusic.analysis)
        startedFade = false
        phase = .armed(at: cutTime)
    }

    /// 曲の終わり基準で予約する（アウトロでつなぐ場合）。
    func armBeforeEnd(bars: Int = 8) {
        guard let appleMusic, appleMusic.duration > 0, appleMusic.manualBPM > 0 else { return }
        let beatSeconds = 60 / appleMusic.manualBPM
        fadeLength = beatSeconds * 4 * Double(fadeBars)
        cutTime = snapToDownbeat(appleMusic.duration - beatSeconds * 4 * Double(bars),
                                 analysis: appleMusic.analysis)
        startedFade = false
        phase = .armed(at: cutTime)
    }

    func cancel() {
        phase = .idle
        startedFade = false
    }

    /// アプリのティッカーから毎フレーム呼ばれる。
    func tick() {
        guard isArmed, let engine, let appleMusic else { return }
        let deck = engine.deck(localDeckID)
        let now = appleMusic.playbackTime
        let fadeStart = cutTime - fadeLength
        guard fadeLength > 0 else { return }

        if now < fadeStart { return }

        if !startedFade {
            startedFade = true
            beginFade(deck: deck)
        }

        let progress = min(1, max(0, (now - fadeStart) / fadeLength))
        phase = .running(progress: progress)
        applyFade(deck: deck, progress: progress)

        if now >= cutTime {
            complete(deck: deck)
        }
    }

    // MARK: - フェード本体

    private func beginFade(deck: Deck) {
        switch direction {
        case .appleMusicToDeck:
            deck.faderLevel = 0
            // 拍頭から入るようにキュー点へ戻してから走らせる。
            if deck.analysis.isUsable {
                deck.seek(to: deck.analysis.beat(atOrBefore: deck.playhead) ?? deck.playhead)
            }
            deck.play()
        case .deckToAppleMusic:
            deck.faderLevel = 1
            Task { await appleMusic?.play() }
        }
    }

    private func applyFade(deck: Deck, progress: Double) {
        // 等パワーカーブ。リニアだと中盤で音圧が落ちる。
        switch direction {
        case .appleMusicToDeck:
            deck.faderLevel = sin(progress * .pi / 2)
        case .deckToAppleMusic:
            deck.faderLevel = cos(progress * .pi / 2)
        }
    }

    private func complete(deck: Deck) {
        switch direction {
        case .appleMusicToDeck:
            deck.faderLevel = 1
            appleMusic?.pause()
        case .deckToAppleMusic:
            deck.faderLevel = 0
            deck.pause()
        }
        phase = .finished
        startedFade = false
    }

    /// 小節頭（4 拍ごと）に吸着させる。
    private func snapToDownbeat(_ time: TimeInterval, analysis: TrackAnalysis) -> TimeInterval {
        guard analysis.isUsable else { return time }
        let bar = 60 / analysis.bpm * 4
        let offset = analysis.firstBeat
        let bars = ((time - offset) / bar).rounded()
        return max(0, offset + bars * bar)
    }

    /// 予約中の残り時間（Apple Music の再生位置基準）。
    func remaining(from playbackTime: TimeInterval) -> TimeInterval? {
        guard isArmed else { return nil }
        return max(0, cutTime - fadeLength - playbackTime)
    }
}

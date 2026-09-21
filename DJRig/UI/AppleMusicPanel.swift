import MusicKit
import SwiftUI

/// Apple Music デッキのストリップ。
/// 音声処理ができない代わりに「BPM を手で決めて、小節頭でカットする」ための道具を並べる。
struct AppleMusicPanel: View {
    @Environment(AppModel.self) private var model

    private var deck: AppleMusicDeck { model.appleMusic }

    var body: some View {
        HStack(spacing: 14) {
            nowPlaying
            Divider().overlay(Theme.stroke)
            transport
            Divider().overlay(Theme.stroke)
            tempoSection
            Divider().overlay(Theme.stroke)
            transitionSection(transition: model.transition)
        }
        .padding(12)
        .panel()
    }

    // MARK: - 再生中

    private var nowPlaying: some View {
        HStack(spacing: 10) {
            Image(systemName: "applelogo")
                .font(.system(size: 16))
                .foregroundStyle(Theme.appleMusic)

            VStack(alignment: .leading, spacing: 1) {
                Text(deck.nowPlaying?.title ?? "Apple Music デッキ")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(deck.nowPlaying?.artist ?? "ブラウザから曲を送ってください")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }
            .frame(width: 180, alignment: .leading)

            VStack(alignment: .trailing, spacing: 1) {
                Text(deck.playbackTime.asClock)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.textPrimary)
                Text("-" + max(0, deck.duration - deck.playbackTime).asClock)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    // MARK: - トランスポート

    private var transport: some View {
        HStack(spacing: 6) {
            iconButton("gobackward.minus", label: "1 小節戻る") { deck.jumpBars(-1) }
            iconButton(deck.isPlaying ? "pause.fill" : "play.fill",
                       label: deck.isPlaying ? "一時停止" : "再生",
                       tint: Theme.appleMusic) {
                Task { await deck.togglePlay() }
            }
            iconButton("goforward.plus", label: "1 小節進む") { deck.jumpBars(1) }
            iconButton("forward.end.fill", label: "次の曲") {
                Task { await deck.skipToNext() }
            }
        }
    }

    private func iconButton(_ systemImage: String,
                            label: String,
                            tint: Color = Theme.textSecondary,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 34, height: 30)
        }
        .buttonStyle(.plain)
        .background(Theme.panelRaised, in: RoundedRectangle(cornerRadius: 6))
        .foregroundStyle(tint)
        .accessibilityLabel(label)
        .disabled(deck.nowPlaying == nil)
    }

    // MARK: - テンポ

    private var tempoSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(String(format: "%.1f", deck.manualBPM))
                    .font(.system(size: 16, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.textPrimary)
                Text("BPM")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)

                Stepper("") {
                    deck.manualBPM = min(200, deck.manualBPM + 0.1)
                } onDecrement: {
                    deck.manualBPM = max(60, deck.manualBPM - 0.1)
                }
                .labelsHidden()
                .controlSize(.mini)
            }

            HStack(spacing: 5) {
                Button("TAP") { deck.tapTempo() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Button("拍頭") { deck.markDownbeat() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }

            Text("解析できないため手動で合わせます")
                .font(.system(size: 8))
                .foregroundStyle(Theme.textSecondary.opacity(0.8))
        }
        .frame(width: 150, alignment: .leading)
    }

    // MARK: - 自動つなぎ

    private func transitionSection(transition: AutoTransitionController) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Picker("", selection: Binding(get: { transition.direction },
                                              set: { transition.direction = $0 })) {
                    ForEach(AutoTransitionController.Direction.allCases) { direction in
                        Text(direction.rawValue).tag(direction)
                    }
                }
                .pickerStyle(.menu)
                .controlSize(.small)

                Picker("", selection: Binding(get: { transition.localDeckID },
                                              set: { transition.localDeckID = $0 })) {
                    ForEach(DeckID.allCases) { deckID in
                        Text("デッキ \(deckID.rawValue)").tag(deckID)
                    }
                }
                .pickerStyle(.menu)
                .controlSize(.small)
            }

            HStack(spacing: 6) {
                Text("\(transition.fadeBars) 小節でつなぐ")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textSecondary)
                Stepper("") {
                    transition.fadeBars = min(32, transition.fadeBars + 4)
                } onDecrement: {
                    transition.fadeBars = max(2, transition.fadeBars - 2)
                }
                .labelsHidden()
                .controlSize(.mini)
            }

            HStack(spacing: 5) {
                Button(transition.isArmed ? "解除" : "16 小節後") {
                    transition.isArmed ? transition.cancel() : transition.arm(afterBars: 16)
                }
                .buttonStyle(.borderedProminent)
                .tint(transition.isArmed ? .red : Theme.appleMusic)
                .controlSize(.small)
                .disabled(deck.nowPlaying == nil)

                Button("アウトロ") { transition.armBeforeEnd(bars: 8) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(deck.nowPlaying == nil || deck.duration <= 0)
            }

            statusLine(transition: transition)
        }
        .frame(width: 290, alignment: .leading)
    }

    @ViewBuilder
    private func statusLine(transition: AutoTransitionController) -> some View {
        switch transition.phase {
        case .idle:
            Text("待機中")
                .font(.system(size: 9))
                .foregroundStyle(Theme.textSecondary.opacity(0.7))
        case .armed:
            Text("予約済み — 開始まで \((transition.remaining(from: deck.playbackTime) ?? 0).asClock)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(Theme.warning)
        case .running(let progress):
            ProgressView(value: progress)
                .progressViewStyle(.linear)
                .tint(Theme.appleMusic)
        case .finished:
            Text("つなぎ完了")
                .font(.system(size: 9))
                .foregroundStyle(Theme.textSecondary)
        }
    }
}

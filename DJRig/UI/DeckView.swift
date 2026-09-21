import SwiftUI

struct DeckView: View {
    @Environment(AppModel.self) private var model
    let deckID: DeckID

    private var deck: Deck { model.engine.deck(deckID) }
    private var accent: Color { Theme.accent(for: deckID) }

    var body: some View {
        VStack(spacing: 10) {
            header
            waveforms
            HStack(alignment: .top, spacing: 12) {
                jogColumn
                controlsColumn
            }
            hotCues
        }
        .padding(12)
        .panel()
    }

    // MARK: - ヘッダ

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(deckID.rawValue)
                .font(.system(size: 20, weight: .black, design: .rounded))
                .foregroundStyle(accent)

            VStack(alignment: .leading, spacing: 1) {
                Text(deck.track?.title ?? "曲が読み込まれていません")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(deck.track?.displaySubtitle ?? "ブラウザから曲をロード")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if model.isLoading(deckID) {
                ProgressView().controlSize(.small)
            }

            VStack(alignment: .trailing, spacing: 1) {
                Text(deck.analysis.isUsable
                     ? String(format: "%.2f", deck.effectiveBPM)
                     : "---")
                    .font(.system(size: 15, weight: .bold, design: .monospaced))
                    .foregroundStyle(deck.analysis.confidence < 0.25 && deck.analysis.isUsable
                                     ? Theme.warning : Theme.textPrimary)
                Text("BPM")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
            }

            VStack(alignment: .trailing, spacing: 1) {
                Text(deck.playhead.asClock)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.textPrimary)
                Text("-" + max(0, deck.duration - deck.playhead).asClock)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    // MARK: - 波形

    private var waveforms: some View {
        VStack(spacing: 6) {
            WaveformStrip(bins: deck.waveform,
                          position: deck.playhead,
                          duration: deck.duration,
                          analysis: deck.analysis,
                          loopRange: deck.loopRange,
                          accent: accent)
                .frame(height: 78)

            WaveformOverview(bins: deck.waveform,
                             position: deck.playhead,
                             duration: deck.duration,
                             cuePoints: deck.cuePoints,
                             accent: accent) { time in
                deck.seek(to: time)
            }
        }
    }

    // MARK: - ジョグ + トランスポート

    private var jogColumn: some View {
        VStack(spacing: 8) {
            JogWheel(accent: accent,
                     rotation: deck.playhead / 1.8 * 2 * .pi,
                     isPlaying: deck.isPlaying) { delta in
                deck.nudge(by: delta)
            }
            .frame(maxWidth: 120)

            HStack(spacing: 8) {
                TransportButton(systemImage: "smallcircle.filled.circle",
                                label: "CUE",
                                tint: Theme.warning,
                                isActive: false) {
                    deck.cue()
                }
                TransportButton(systemImage: deck.isPlaying ? "pause.fill" : "play.fill",
                                label: deck.isPlaying ? "PAUSE" : "PLAY",
                                tint: accent,
                                isActive: deck.isPlaying) {
                    deck.togglePlay()
                }
            }
        }
    }

    // MARK: - テンポ / ループ

    private var controlsColumn: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                VStack(spacing: 4) {
                    VerticalFader(value: Binding(
                        get: { deck.tempoRatio },
                        set: { deck.tempoRatio = $0 }
                    ), range: 0.92...1.08, accent: accent, centered: true, height: 124)
                    Text(String(format: "%+.1f%%", (deck.tempoRatio - 1) * 100))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(Theme.textSecondary)
                    Text("TEMPO").font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                }

                VStack(spacing: 6) {
                    ToggleChip(title: "SYNC", isOn: false, tint: accent) {
                        model.sync(deckID)
                    }
                    ToggleChip(title: "KEY", isOn: deck.keyLock, tint: accent) {
                        deck.keyLock.toggle()
                    }
                    ToggleChip(title: "MASTER", isOn: model.syncMaster == deckID, tint: accent) {
                        model.syncMaster = deckID
                    }
                    Button {
                        deck.tempoRatio = 1
                    } label: {
                        Text("RESET")
                            .font(.system(size: 9, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                    .background(Theme.panelRaised, in: RoundedRectangle(cornerRadius: 6))
                    .foregroundStyle(Theme.textSecondary)
                }
                .frame(width: 66)
            }

            loopControls
        }
    }

    private var loopControls: some View {
        VStack(spacing: 5) {
            HStack(spacing: 4) {
                ForEach(LoopLength.allCases) { length in
                    Button {
                        deck.setLoopLength(length)
                    } label: {
                        Text(length.label)
                            .font(.system(size: 9, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                    .background(deck.loopLength == length ? Theme.warning.opacity(0.85) : Theme.panelRaised,
                                in: RoundedRectangle(cornerRadius: 5))
                    .foregroundStyle(deck.loopLength == length ? .black : Theme.textSecondary)
                }
            }
            Button {
                deck.toggleLoop()
            } label: {
                Text(deck.loopEnabled ? "LOOP EXIT" : "LOOP IN")
                    .font(.system(size: 10, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
            .background(deck.loopEnabled ? Theme.warning : Theme.panelRaised,
                        in: RoundedRectangle(cornerRadius: 6))
            .foregroundStyle(deck.loopEnabled ? .black : Theme.textPrimary)
            .disabled(!deck.isLoaded)
        }
    }

    // MARK: - ホットキュー

    private var hotCues: some View {
        HStack(spacing: 6) {
            ForEach(deck.cuePoints) { cue in
                Button {
                    if cue.time > 0 {
                        deck.jumpToHotCue(cue.index)
                    } else {
                        deck.setHotCue(cue.index)
                    }
                } label: {
                    VStack(spacing: 1) {
                        Text("\(cue.index + 1)")
                            .font(.system(size: 11, weight: .bold))
                        Text(cue.time > 0 ? cue.time.asClock : "SET")
                            .font(.system(size: 8, design: .monospaced))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)
                .background(cue.time > 0 ? Theme.warning.opacity(0.8) : Theme.panelRaised,
                            in: RoundedRectangle(cornerRadius: 6))
                .foregroundStyle(cue.time > 0 ? .black : Theme.textSecondary)
                .contextMenu {
                    Button("上書き") { deck.setHotCue(cue.index) }
                    Button("消去", role: .destructive) { deck.clearHotCue(cue.index) }
                }
                .disabled(!deck.isLoaded)
            }
        }
    }
}

// MARK: - 部品

struct TransportButton: View {
    let systemImage: String
    let label: String
    let tint: Color
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                Text(label)
                    .font(.system(size: 8, weight: .bold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
        }
        .buttonStyle(.plain)
        .background(isActive ? tint.opacity(0.85) : Theme.panelRaised,
                    in: RoundedRectangle(cornerRadius: 8))
        .foregroundStyle(isActive ? .black : tint)
        .accessibilityLabel(label)
    }
}

struct ToggleChip: View {
    let title: String
    let isOn: Bool
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
        }
        .buttonStyle(.plain)
        .background(isOn ? tint.opacity(0.85) : Theme.panelRaised,
                    in: RoundedRectangle(cornerRadius: 6))
        .foregroundStyle(isOn ? .black : Theme.textSecondary)
    }
}

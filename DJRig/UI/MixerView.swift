import SwiftUI

/// 中央のミキサー。EQ・フィルタ・チャンネルフェーダー・クロスフェーダー・録音。
struct MixerView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var engine = model.engine

        VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 14) {
                channelStrip(for: .a)
                masterColumn
                channelStrip(for: .b)
            }

            VStack(spacing: 4) {
                Crossfader2D(position: $engine.crossfaderPosition)
                Picker("カーブ", selection: $engine.crossfaderCurve) {
                    ForEach(CrossfaderCurve.allCases) { curve in
                        Text(curve.rawValue).tag(curve)
                    }
                }
                .pickerStyle(.segmented)
                .controlSize(.mini)
            }
        }
        .padding(12)
        .panel()
    }

    // MARK: - チャンネル

    private func channelStrip(for deckID: DeckID) -> some View {
        let deck = model.engine.deck(deckID)
        let accent = Theme.accent(for: deckID)

        return VStack(spacing: 8) {
            Text(deckID.rawValue)
                .font(.system(size: 13, weight: .black, design: .rounded))
                .foregroundStyle(accent)

            Knob(title: "TRIM",
                 value: Binding(get: { deck.trimDB }, set: { deck.trimDB = $0 }),
                 range: -12...12,
                 accent: accent,
                 format: { String(format: "%+.0f", $0) })

            Knob(title: "HIGH",
                 value: Binding(get: { deck.eqHigh }, set: { deck.eqHigh = $0 }),
                 range: -26...6,
                 accent: accent,
                 format: { String(format: "%+.0f", $0) })

            Knob(title: "MID",
                 value: Binding(get: { deck.eqMid }, set: { deck.eqMid = $0 }),
                 range: -26...6,
                 accent: accent,
                 format: { String(format: "%+.0f", $0) })

            Knob(title: "LOW",
                 value: Binding(get: { deck.eqLow }, set: { deck.eqLow = $0 }),
                 range: -26...6,
                 accent: accent,
                 format: { String(format: "%+.0f", $0) })

            Knob(title: "FILTER",
                 value: Binding(get: { deck.filter }, set: { deck.filter = $0 }),
                 range: -1...1,
                 accent: Theme.warning,
                 format: { value in
                     if abs(value) < 0.02 { return "OFF" }
                     return value < 0 ? "LPF" : "HPF"
                 })

            HStack(spacing: 6) {
                LevelMeter(level: deck.level, accent: accent)
                VerticalFader(value: Binding(get: { deck.faderLevel },
                                             set: { deck.faderLevel = $0 }),
                              accent: accent,
                              height: 150)
            }
        }
        .frame(width: 104)
    }

    // MARK: - マスター

    private var masterColumn: some View {
        @Bindable var engine = model.engine

        return VStack(spacing: 10) {
            Text("MASTER")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.textSecondary)

            Knob(title: "GAIN",
                 value: $engine.masterGain,
                 range: 0...1.2,
                 accent: .white,
                 bipolar: false,
                 format: { String(format: "%.0f%%", $0 * 100) },
                 resetValue: 0.85)

            LevelMeter(level: engine.masterLevel, accent: .white, segments: 22)
                .frame(height: 130)

            Button {
                model.engine.toggleRecording()
            } label: {
                VStack(spacing: 2) {
                    Image(systemName: engine.recorder.isRecording ? "stop.circle.fill" : "record.circle")
                        .font(.system(size: 18))
                    Text(engine.recorder.isRecording ? engine.recorder.elapsed.asClock : "REC")
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
            }
            .buttonStyle(.plain)
            .background(engine.recorder.isRecording ? Color.red.opacity(0.85) : Theme.panelRaised,
                        in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(engine.recorder.isRecording ? .white : Theme.textSecondary)
            .help("ローカルデッキのミックスのみ録音されます（Apple Music の音は含まれません）")
        }
        .frame(width: 84)
    }
}

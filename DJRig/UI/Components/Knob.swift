import SwiftUI

/// 縦ドラッグで回すノブ。EQ / フィルタ用。
struct Knob: View {
    let title: String
    @Binding var value: Double
    var range: ClosedRange<Double> = -1...1
    var accent: Color = .white
    /// 中央が基準値（EQ / フィルタ）なら `true`。
    var bipolar: Bool = true
    var format: (Double) -> String = { String(format: "%.1f", $0) }
    /// ダブルタップで戻す値。
    var resetValue: Double = 0

    @State private var dragStart: Double?

    private var normalized: Double {
        let span = range.upperBound - range.lowerBound
        guard span > 0 else { return 0 }
        return (value - range.lowerBound) / span
    }

    /// つまみの回転角。-135°...+135°。
    private var angle: Angle {
        .degrees(-135 + normalized * 270)
    }

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(Theme.panelRaised)
                Circle()
                    .stroke(Theme.stroke, lineWidth: 1)

                // 現在値を示す弧。
                Circle()
                    .trim(from: bipolar ? min(Self.arcCentre, arcEnd) : 0,
                          to: bipolar ? max(Self.arcCentre, arcEnd) : arcEnd)
                    .stroke(accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(135))
                    .padding(3)

                // つまみのポインタ。
                Capsule()
                    .fill(Theme.textPrimary)
                    .frame(width: 2.5, height: 11)
                    .offset(y: -10)
                    .rotationEffect(angle)
            }
            .frame(width: 46, height: 46)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        let start = dragStart ?? value
                        if dragStart == nil { dragStart = value }
                        let span = range.upperBound - range.lowerBound
                        // 140pt のドラッグでフルレンジ。
                        let delta = Double(-gesture.translation.height) / 140 * span
                        value = min(max(range.lowerBound, start + delta), range.upperBound)
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .onTapGesture(count: 2) { value = resetValue }

            Text(title)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            Text(format(value))
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(Theme.textSecondary.opacity(0.8))
        }
        .accessibilityElement()
        .accessibilityLabel(title)
        .accessibilityValue(format(value))
        .accessibilityAdjustableAction { direction in
            let step = (range.upperBound - range.lowerBound) / 20
            switch direction {
            case .increment: value = min(range.upperBound, value + step)
            case .decrement: value = max(range.lowerBound, value - step)
            default: break
            }
        }
    }

    /// つまみの可動域は 270°、つまり円周の 0.75。
    private static let arcSweep: Double = 0.75
    /// 中央（0 位置）に対応する弧の位置。
    private static let arcCentre: Double = arcSweep / 2

    private var arcEnd: Double {
        normalized * Self.arcSweep
    }
}

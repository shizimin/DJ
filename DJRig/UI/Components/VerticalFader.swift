import SwiftUI

/// チャンネルフェーダー / テンポフェーダー。
struct VerticalFader: View {
    @Binding var value: Double
    var range: ClosedRange<Double> = 0...1
    var accent: Color = .white
    /// つまみを中央基準で描くか（テンポフェーダー用）。
    var centered: Bool = false
    var height: CGFloat = 170

    @State private var dragStart: Double?

    private var normalized: Double {
        let span = range.upperBound - range.lowerBound
        guard span > 0 else { return 0 }
        return (value - range.lowerBound) / span
    }

    var body: some View {
        GeometryReader { proxy in
            let usable = proxy.size.height - 26
            ZStack(alignment: .top) {
                // レール
                Capsule()
                    .fill(Color.black.opacity(0.55))
                    .frame(width: 6)
                    .frame(maxWidth: .infinity)

                // 現在値の塗り
                if !centered {
                    VStack {
                        Spacer(minLength: 0)
                        Capsule()
                            .fill(accent.opacity(0.65))
                            .frame(width: 6, height: max(0, usable * normalized))
                    }
                    .padding(.vertical, 13)
                    .frame(maxWidth: .infinity)
                }

                // つまみ
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Theme.panelRaised)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .stroke(Theme.stroke, lineWidth: 1)
                    )
                    .overlay(
                        Rectangle()
                            .fill(accent)
                            .frame(height: 2)
                    )
                    .frame(width: 38, height: 22)
                    .offset(y: usable * (1 - normalized))
                    .frame(maxWidth: .infinity)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        let start = dragStart ?? value
                        if dragStart == nil { dragStart = value }
                        let span = range.upperBound - range.lowerBound
                        let delta = Double(-gesture.translation.height) / max(1, usable) * span
                        value = min(max(range.lowerBound, start + delta), range.upperBound)
                    }
                    .onEnded { _ in dragStart = nil }
            )
        }
        .frame(width: 44, height: height)
    }
}

/// 横向きのクロスフェーダー。
struct Crossfader2D: View {
    @Binding var position: Double
    var accentA: Color = Theme.deckA
    var accentB: Color = Theme.deckB

    @State private var dragStart: Double?

    var body: some View {
        GeometryReader { proxy in
            let usable = proxy.size.width - 52
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.black.opacity(0.55))
                    .frame(height: 8)
                    .frame(maxHeight: .infinity)

                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(Theme.panelRaised)
                    .overlay(
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .stroke(Theme.stroke, lineWidth: 1)
                    )
                    .overlay(
                        LinearGradient(colors: [accentA, accentB],
                                       startPoint: .leading,
                                       endPoint: .trailing)
                            .frame(width: 2)
                    )
                    .frame(width: 52, height: 40)
                    .offset(x: usable * min(max(0, position), 1))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        let start = dragStart ?? position
                        if dragStart == nil { dragStart = position }
                        position = min(max(0, start + Double(gesture.translation.width) / max(1, usable)), 1)
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .onTapGesture(count: 2) { position = 0.5 }
        }
        .frame(height: 44)
    }
}

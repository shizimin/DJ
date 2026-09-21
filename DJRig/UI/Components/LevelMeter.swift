import SwiftUI

/// 縦型のレベルメーター。
struct LevelMeter: View {
    var level: Float
    var accent: Color
    var segments: Int = 16

    var body: some View {
        let lit = Int((Double(min(max(0, level), 1)).squareRoot() * Double(segments)).rounded())
        VStack(spacing: 2) {
            ForEach(0..<segments, id: \.self) { index in
                let position = segments - 1 - index
                RoundedRectangle(cornerRadius: 1)
                    .fill(color(for: position, lit: lit))
                    .frame(height: 4)
            }
        }
        .frame(width: 8)
        .accessibilityHidden(true)
    }

    private func color(for position: Int, lit: Int) -> Color {
        guard position < lit else { return Color.white.opacity(0.07) }
        let ratio = Double(position) / Double(segments)
        if ratio > 0.92 { return .red }
        if ratio > 0.78 { return Theme.warning }
        return accent
    }
}

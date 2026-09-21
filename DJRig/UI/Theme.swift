import SwiftUI

enum Theme {
    static let background = Color(red: 0.05, green: 0.055, blue: 0.07)
    static let panel = Color(red: 0.10, green: 0.11, blue: 0.13)
    static let panelRaised = Color(red: 0.15, green: 0.16, blue: 0.19)
    static let stroke = Color.white.opacity(0.08)
    static let textPrimary = Color.white.opacity(0.92)
    static let textSecondary = Color.white.opacity(0.55)

    static let deckA = Color(red: 0.25, green: 0.80, blue: 0.95)
    static let deckB = Color(red: 1.00, green: 0.56, blue: 0.22)
    static let appleMusic = Color(red: 0.98, green: 0.24, blue: 0.35)

    static let warning = Color(red: 1.0, green: 0.78, blue: 0.25)

    static func accent(for deck: DeckID) -> Color {
        deck == .a ? deckA : deckB
    }

    static let monoDigits = Font.system(.body, design: .monospaced).monospacedDigit()
}

struct PanelBackground: ViewModifier {
    var cornerRadius: CGFloat = 12

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Theme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Theme.stroke, lineWidth: 1)
            )
    }
}

extension View {
    func panel(cornerRadius: CGFloat = 12) -> some View {
        modifier(PanelBackground(cornerRadius: cornerRadius))
    }
}

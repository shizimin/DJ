import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var showingBrowser = true

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    DeckView(deckID: .a)
                        .frame(maxWidth: .infinity)
                    MixerView()
                        .fixedSize(horizontal: true, vertical: false)
                    DeckView(deckID: .b)
                        .frame(maxWidth: .infinity)
                }
                .layoutPriority(1)

                AppleMusicPanel()

                if showingBrowser {
                    BrowserView()
                        .frame(height: 200)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(10)

            statusOverlay
        }
        .overlay(alignment: .bottomTrailing) {
            Button {
                withAnimation(.snappy) { showingBrowser.toggle() }
            } label: {
                Image(systemName: showingBrowser ? "chevron.down" : "chevron.up")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)
            .background(Theme.panelRaised, in: Circle())
            .foregroundStyle(Theme.textSecondary)
            .padding(16)
            .accessibilityLabel(showingBrowser ? "ブラウザを閉じる" : "ブラウザを開く")
        }
    }

    @ViewBuilder
    private var statusOverlay: some View {
        if let message = model.statusMessage {
            VStack {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.warning)
                    Text(message)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textPrimary)
                    Button {
                        model.clearStatus()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .bold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.textSecondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.panelRaised, in: Capsule())
                .overlay(Capsule().stroke(Theme.stroke, lineWidth: 1))
                .padding(.top, 14)

                Spacer()
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

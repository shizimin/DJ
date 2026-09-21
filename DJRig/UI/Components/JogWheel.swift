import SwiftUI

/// ジョグホイール。回した分だけ再生位置を動かす。
/// 1 回転 = `secondsPerTurn` 秒（既定 1.8 秒 ≒ 33 1/3 回転のレコード 1 周）。
struct JogWheel: View {
    var accent: Color
    var rotation: Double          // ラジアン。再生位置から計算して渡す。
    var isPlaying: Bool
    var secondsPerTurn: Double = 1.8
    var onScrub: (TimeInterval) -> Void
    var onTouchDown: () -> Void = {}
    var onTouchUp: () -> Void = {}

    @State private var lastAngle: Double?

    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)

            ZStack {
                Circle()
                    .fill(
                        RadialGradient(colors: [Theme.panelRaised, Theme.panel],
                                       center: .center,
                                       startRadius: size * 0.1,
                                       endRadius: size * 0.5)
                    )
                Circle()
                    .stroke(Theme.stroke, lineWidth: 1)

                // 外周のインジケータ（回転方向が目で追える）。
                Circle()
                    .trim(from: 0, to: 0.06)
                    .stroke(accent, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.radians(rotation - .pi / 2))
                    .padding(6)

                Circle()
                    .fill(Theme.background)
                    .padding(size * 0.22)
                Circle()
                    .stroke(accent.opacity(isPlaying ? 0.55 : 0.2), lineWidth: 2)
                    .padding(size * 0.22)

                Image(systemName: isPlaying ? "waveform" : "pause")
                    .font(.system(size: size * 0.14, weight: .light))
                    .foregroundStyle(accent.opacity(0.5))
            }
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        let angle = atan2(gesture.location.y - center.y,
                                          gesture.location.x - center.x)
                        defer { lastAngle = angle }
                        guard let previous = lastAngle else {
                            onTouchDown()
                            return
                        }
                        var delta = angle - previous
                        // -π..π をまたいだときの折り返しを直す。
                        if delta > .pi { delta -= 2 * .pi }
                        if delta < -.pi { delta += 2 * .pi }
                        onScrub(delta / (2 * .pi) * secondsPerTurn)
                    }
                    .onEnded { _ in
                        lastAngle = nil
                        onTouchUp()
                    }
            )
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

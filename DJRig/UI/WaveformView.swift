import SwiftUI

/// 拡大波形。中央が再生位置で、ビートグリッドとループ範囲を重ねる。
struct WaveformStrip: View {
    let bins: [WaveformBin]
    let position: TimeInterval
    let duration: TimeInterval
    let analysis: TrackAnalysis
    let loopRange: ClosedRange<TimeInterval>?
    let accent: Color
    /// 画面に表示する秒数。
    var window: TimeInterval = 8

    var body: some View {
        Canvas { context, size in
            guard duration > 0, !bins.isEmpty else { return }
            let start = position - window / 2
            let end = position + window / 2
            let pixelsPerSecond = size.width / window
            let binsPerSecond = Double(bins.count) / duration
            let midY = size.height / 2

            // ループ範囲
            if let loopRange {
                let x0 = (loopRange.lowerBound - start) * pixelsPerSecond
                let x1 = (loopRange.upperBound - start) * pixelsPerSecond
                let rect = CGRect(x: x0, y: 0, width: max(1, x1 - x0), height: size.height)
                context.fill(Path(rect), with: .color(Theme.warning.opacity(0.16)))
            }

            // 波形本体（1 ピクセルに 1 本）
            let columns = Int(size.width)
            guard columns > 0 else { return }
            for column in 0..<columns {
                let time = start + Double(column) / pixelsPerSecond
                guard time >= 0, time <= duration else { continue }
                let binIndex = Int(time * binsPerSecond)
                guard bins.indices.contains(binIndex) else { continue }
                let bin = bins[binIndex]
                let height = CGFloat(bin.peak) * midY * 0.95
                guard height > 0.2 else { continue }
                let x = CGFloat(column) + 0.5
                let path = Path { p in
                    p.move(to: CGPoint(x: x, y: midY - height))
                    p.addLine(to: CGPoint(x: x, y: midY + height))
                }
                // 低域が強いほど濃く塗り、その上に高域ぶんの白を重ねる。
                context.stroke(path,
                               with: .color(accent.opacity(0.42 + 0.58 * Double(min(1, bin.low)))),
                               lineWidth: 1)
                let high = Double(min(1, bin.high))
                if high > 0.05 {
                    context.stroke(path, with: .color(.white.opacity(high * 0.32)), lineWidth: 1)
                }
            }

            // ビートグリッド
            if analysis.isUsable {
                let beat = 60 / analysis.bpm
                var beatTime = analysis.firstBeat + floor((start - analysis.firstBeat) / beat) * beat
                var index = Int(((beatTime - analysis.firstBeat) / beat).rounded())
                while beatTime < end {
                    if beatTime >= 0 {
                        let x = (beatTime - start) * pixelsPerSecond
                        let isDownbeat = index % 4 == 0
                        let path = Path { p in
                            p.move(to: CGPoint(x: x, y: isDownbeat ? 0 : size.height * 0.28))
                            p.addLine(to: CGPoint(x: x, y: isDownbeat ? size.height : size.height * 0.72))
                        }
                        context.stroke(path,
                                       with: .color(.white.opacity(isDownbeat ? 0.32 : 0.14)),
                                       lineWidth: isDownbeat ? 1.2 : 0.7)
                    }
                    beatTime += beat
                    index += 1
                }
            }

            // 再生ヘッド（中央固定）
            let head = Path { p in
                p.move(to: CGPoint(x: size.width / 2, y: 0))
                p.addLine(to: CGPoint(x: size.width / 2, y: size.height))
            }
            context.stroke(head, with: .color(.white), lineWidth: 2)
        }
        .background(Color.black.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// 曲全体の俯瞰波形。タップ / ドラッグでシーク、ホットキューも表示する。
struct WaveformOverview: View {
    let bins: [WaveformBin]
    let position: TimeInterval
    let duration: TimeInterval
    let cuePoints: [CuePoint]
    let accent: Color
    let onSeek: (TimeInterval) -> Void

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                guard duration > 0, !bins.isEmpty else { return }
                let midY = size.height / 2
                let columns = Int(size.width)
                guard columns > 0 else { return }

                for column in 0..<columns {
                    let ratio = Double(column) / Double(columns)
                    let binIndex = Int(ratio * Double(bins.count))
                    guard bins.indices.contains(binIndex) else { continue }
                    let bin = bins[binIndex]
                    let height = CGFloat(bin.peak) * midY * 0.9
                    let played = ratio <= position / duration
                    let path = Path { p in
                        p.move(to: CGPoint(x: CGFloat(column) + 0.5, y: midY - height))
                        p.addLine(to: CGPoint(x: CGFloat(column) + 0.5, y: midY + height))
                    }
                    context.stroke(path,
                                   with: .color(played ? accent : Color.white.opacity(0.22)),
                                   lineWidth: 1)
                }

                for cue in cuePoints where cue.time > 0 {
                    let x = CGFloat(cue.time / duration) * size.width
                    let path = Path { p in
                        p.move(to: CGPoint(x: x, y: 0))
                        p.addLine(to: CGPoint(x: x, y: size.height))
                    }
                    context.stroke(path, with: .color(Theme.warning), lineWidth: 1.5)
                }

                let x = CGFloat(position / duration) * size.width
                let head = Path { p in
                    p.move(to: CGPoint(x: x, y: 0))
                    p.addLine(to: CGPoint(x: x, y: size.height))
                }
                context.stroke(head, with: .color(.white), lineWidth: 1.5)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        guard duration > 0, proxy.size.width > 0 else { return }
                        let ratio = min(max(0, gesture.location.x / proxy.size.width), 1)
                        onSeek(Double(ratio) * duration)
                    }
            )
        }
        .frame(height: 40)
        .background(Color.black.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityHidden(true)
    }
}

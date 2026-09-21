import Foundation

/// クロスフェーダーのカーブ。
enum CrossfaderCurve: String, CaseIterable, Identifiable {
    /// 中央でも両方が -3dB で鳴る。ロングミックス向け。
    case constantPower = "Smooth"
    /// 線形。
    case linear = "Linear"
    /// 端に寄せた瞬間に切り替わる。スクラッチ / カットイン向け。
    case sharp = "Sharp"

    var id: String { rawValue }
}

enum Crossfader {
    /// `position` は 0（A 全開）...1（B 全開）。
    static func gains(position: Double, curve: CrossfaderCurve) -> (a: Double, b: Double) {
        let x = min(max(0, position), 1)
        switch curve {
        case .linear:
            return (1 - x, x)
        case .constantPower:
            return (cos(x * .pi / 2), sin(x * .pi / 2))
        case .sharp:
            // 中央付近で一気に入れ替わる。端 10% でフル。
            let a = min(1, max(0, (0.9 - x) / 0.4))
            let b = min(1, max(0, (x - 0.1) / 0.4))
            return (a, b)
        }
    }
}

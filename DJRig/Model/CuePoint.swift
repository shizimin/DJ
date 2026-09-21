import Foundation

/// ホットキュー。1 デッキにつき 4 つ。
struct CuePoint: Identifiable, Hashable, Codable {
    var id: UUID = UUID()
    var index: Int
    var time: TimeInterval
    var label: String = ""
}

/// ループの長さ（拍数）。
enum LoopLength: Double, CaseIterable, Identifiable {
    case quarter = 0.25
    case half = 0.5
    case one = 1
    case two = 2
    case four = 4
    case eight = 8
    case sixteen = 16

    var id: Double { rawValue }

    var label: String {
        switch self {
        case .quarter: return "1/4"
        case .half: return "1/2"
        default: return String(Int(rawValue))
        }
    }
}

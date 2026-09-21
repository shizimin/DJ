import AVFoundation
import Foundation
import Observation
import os

/// マスター出力の録音。
///
/// 記録できるのは **このアプリのエンジンが鳴らしている音（ローカルファイルのデッキ）だけ** で、
/// Apple Music の音は一切含まれない。MusicKit の再生は OS 側の別プロセスで行われ、
/// アプリからは取得できない（DRM 保護を回避する実装は行わない）。
@MainActor
@Observable
final class MixRecorder {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "Recorder")

    private(set) var isRecording = false
    private(set) var startedAt: Date?
    private(set) var lastFileURL: URL?

    @ObservationIgnored private var audioFile: AVAudioFile?
    @ObservationIgnored private weak var tappedNode: AVAudioNode?

    var elapsed: TimeInterval {
        guard let startedAt else { return 0 }
        return Date().timeIntervalSince(startedAt)
    }

    func start(on node: AVAudioNode) {
        guard !isRecording else { return }
        // タップは必ずバス自身のフォーマットで取る。食い違うと実行時に落ちる。
        let format = node.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return }
        let name = "Mix-\(Self.timestamp()).caf"
        let url = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(name)

        do {
            // CAF + Linear PCM。DJ ミックスは長尺になるので、圧縮は書き出し後に行う前提。
            let file = try AVAudioFile(forWriting: url, settings: format.settings)
            audioFile = file
            tappedNode = node
            node.installTap(onBus: 0, bufferSize: 4_096, format: nil) { buffer, _ in
                do {
                    try file.write(from: buffer)
                } catch {
                    Self.log.error("write failed: \(error.localizedDescription, privacy: .public)")
                }
            }
            isRecording = true
            startedAt = Date()
            lastFileURL = url
        } catch {
            Self.log.error("could not start recording: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        guard isRecording else { return }
        tappedNode?.removeTap(onBus: 0)
        tappedNode = nil
        audioFile = nil
        isRecording = false
        startedAt = nil
    }

    private static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }
}

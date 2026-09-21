import AVFoundation
import Foundation
import os

enum AudioSessionManager {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "AudioSession")

    /// `.mixWithOthers` を付けるのが要点。これがないと MusicKit の
    /// `ApplicationMusicPlayer` と自前の `AVAudioEngine` が互いを止めてしまう。
    static func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback,
                                    mode: .default,
                                    options: [.mixWithOthers])
            try session.setPreferredSampleRate(48_000)
            // 5ms。ジョグやカットインの応答性を優先する。
            try session.setPreferredIOBufferDuration(0.005)
            try session.setActive(true)
        } catch {
            log.error("audio session activation failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

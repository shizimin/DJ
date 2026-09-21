import Foundation
import MusicKit
import Observation
import os

/// Apple Music 専用のデッキ。
///
/// `ApplicationMusicPlayer` は端末に 1 インスタンスしか存在せず、同時に 2 曲を鳴らせない。
/// また音声バッファを取り出せないので、EQ・フィルタ・テンポ変更・スクラッチはできない。
/// ここで提供するのは **再生制御とビートを意識したカット** まで。
/// ミックスの「フェード側」はローカルデッキのフェーダーで作る（`AutoTransitionController`）。
@MainActor
@Observable
final class AppleMusicDeck {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "AppleMusicDeck")

    @ObservationIgnored private let player = ApplicationMusicPlayer.shared

    private(set) var nowPlaying: Track?
    private(set) var nowPlayingSong: Song?
    private(set) var isPlaying = false
    private(set) var playbackTime: TimeInterval = 0
    private(set) var lastError: String?

    /// 曲の長さ（MusicKit のメタデータから）。
    var duration: TimeInterval { nowPlaying?.duration ?? 0 }

    /// 音声解析ができないため BPM は手入力かタップで決める。
    var manualBPM: Double = 120
    /// 1 拍目の位置（秒）。タップした瞬間の再生位置から決める。
    var firstBeat: TimeInterval = 0

    var analysis: TrackAnalysis {
        TrackAnalysis(bpm: manualBPM, firstBeat: firstBeat, confidence: 1)
    }

    @ObservationIgnored private var tapTimes: [Date] = []

    // MARK: - ロード / 再生

    func load(song: Song) async {
        lastError = nil
        do {
            player.queue = [song]
            try await player.prepareToPlay()
            nowPlayingSong = song
            nowPlaying = MusicKitService.makeTrack(from: song)
            playbackTime = 0
            firstBeat = 0
        } catch {
            lastError = Self.describe(error)
            Self.log.error("load failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// プレイリストなどを丸ごとキューに入れる。
    func load(songs: [Song], startingAt index: Int = 0) async {
        guard songs.indices.contains(index) else { return }
        lastError = nil
        do {
            player.queue = ApplicationMusicPlayer.Queue(for: songs, startingAt: songs[index])
            try await player.prepareToPlay()
            nowPlayingSong = songs[index]
            nowPlaying = MusicKitService.makeTrack(from: songs[index])
            playbackTime = 0
            firstBeat = 0
        } catch {
            lastError = Self.describe(error)
        }
    }

    func play() async {
        do {
            try await player.play()
        } catch {
            lastError = Self.describe(error)
            Self.log.error("play failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func pause() {
        player.pause()
    }

    func togglePlay() async {
        isPlaying ? pause() : await play()
    }

    func stop() {
        player.stop()
        isPlaying = false
        playbackTime = 0
    }

    func seek(to time: TimeInterval) {
        let clamped = max(0, min(time, max(0, duration - 0.5)))
        player.playbackTime = clamped
        playbackTime = clamped
    }

    func skipToNext() async {
        do {
            try await player.skipToNextEntry()
        } catch {
            lastError = Self.describe(error)
        }
    }

    /// 1 小節（4 拍）単位で移動する。
    func jumpBars(_ bars: Int) {
        guard manualBPM > 0 else { return }
        seek(to: playbackTime + Double(bars) * 4 * 60 / manualBPM)
    }

    // MARK: - ティック

    /// アプリのティッカーから毎フレーム呼ばれる。
    func refresh() {
        playbackTime = player.playbackTime
        isPlaying = player.state.playbackStatus == .playing
        // キューが進んで曲が変わったら追従する。
        if let entry = player.queue.currentEntry,
           let item = entry.item,
           case .song(let song) = item,
           song.id != nowPlayingSong?.id {
            nowPlayingSong = song
            nowPlaying = MusicKitService.makeTrack(from: song)
            firstBeat = 0
        }
    }

    // MARK: - タップテンポ

    /// 4 回以上タップすると BPM が決まる。同時に 1 拍目の位置も記録する。
    func tapTempo() {
        let now = Date()
        if let last = tapTimes.last, now.timeIntervalSince(last) > 2.5 {
            tapTimes.removeAll()
        }
        tapTimes.append(now)
        if tapTimes.count > 8 { tapTimes.removeFirst(tapTimes.count - 8) }

        guard tapTimes.count >= 4 else { return }
        var intervals: [TimeInterval] = []
        for index in 1..<tapTimes.count {
            intervals.append(tapTimes[index].timeIntervalSince(tapTimes[index - 1]))
        }
        let average = intervals.reduce(0, +) / Double(intervals.count)
        guard average > 0.2, average < 2.0 else { return }
        manualBPM = (60 / average * 10).rounded() / 10
        // 直近のタップを拍の基準にする。
        firstBeat = playbackTime.truncatingRemainder(dividingBy: 60 / manualBPM)
    }

    /// いま鳴っている位置を「1 拍目」として登録し直す。
    func markDownbeat() {
        guard manualBPM > 0 else { return }
        firstBeat = playbackTime.truncatingRemainder(dividingBy: 60 / manualBPM)
    }

    private static func describe(_ error: Error) -> String {
        error.localizedDescription
    }
}

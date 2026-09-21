import AVFoundation
import Foundation
import Observation

enum DeckID: String, CaseIterable, Identifiable, Sendable {
    case a = "A"
    case b = "B"

    var id: String { rawValue }
    var other: DeckID { self == .a ? .b : .a }
}

/// 1 デッキ分の再生と音作り。
///
/// ノード構成: `player → timePitch → eq(3band + filter) → output(mixer) → master`
/// `player` が読み出すフレーム数はソース時間そのものなので、`timePitch` を挟んでいても
/// `playerTime.sampleTime` からソース上の再生位置を正しく計算できる。
@MainActor
@Observable
final class Deck {
    let id: DeckID

    // MARK: - ノード

    @ObservationIgnored let player = AVAudioPlayerNode()
    @ObservationIgnored let timePitch = AVAudioUnitTimePitch()
    @ObservationIgnored let eq = AVAudioUnitEQ(numberOfBands: 4)
    @ObservationIgnored let output = AVAudioMixerNode()

    private enum Band {
        static let low = 0
        static let mid = 1
        static let high = 2
        static let filter = 3
    }

    // MARK: - ロード済みの曲

    private(set) var track: Track?
    private(set) var waveform: [WaveformBin] = []
    private(set) var duration: TimeInterval = 0
    @ObservationIgnored private var file: AVAudioFile?
    @ObservationIgnored private var scopedURL: URL?

    var analysis: TrackAnalysis { track?.analysis ?? .unknown }
    var isLoaded: Bool { file != nil }

    // MARK: - トランスポート

    private(set) var isPlaying = false
    /// 画面表示用の再生位置。`AppModel` のティッカーが毎フレーム更新する。
    private(set) var playhead: TimeInterval = 0
    /// 出力レベル（0...1、RMS）。
    private(set) var level: Float = 0

    /// `player` の sampleTime 0 に対応するソース時間。
    @ObservationIgnored private var anchor: TimeInterval = 0
    /// ループ時、最初のセグメント（anchor → loopEnd）の長さ。
    @ObservationIgnored private var firstSegmentLength: TimeInterval = 0
    /// `player.stop()` が発火させる古い completion を捨てるための世代番号。
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var meterCounter = 0

    // MARK: - テンポ

    /// 1.0 = 原曲。0.5...2.0。
    var tempoRatio: Double = 1.0 {
        didSet {
            let clamped = min(max(0.5, tempoRatio), 2.0)
            if clamped != tempoRatio { tempoRatio = clamped; return }
            applyTempo()
        }
    }

    /// キーロック（オン = ピッチを保ったままテンポだけ変える）。
    var keyLock: Bool = true {
        didSet { applyTempo() }
    }

    /// テンポ調整後の実効 BPM。
    var effectiveBPM: Double { analysis.bpm * tempoRatio }

    // MARK: - ミキサー

    /// チャンネルフェーダー（0...1）。
    var faderLevel: Double = 1.0 { didSet { applyGain() } }
    /// トリム（-12...+12 dB）。
    var trimDB: Double = 0 { didSet { applyGain() } }
    /// クロスフェーダーから与えられるゲイン（0...1）。
    @ObservationIgnored private(set) var crossfadeGain: Double = 1.0

    var eqLow: Double = 0 { didSet { eq.bands[Band.low].gain = Float(eqLow) } }
    var eqMid: Double = 0 { didSet { eq.bands[Band.mid].gain = Float(eqMid) } }
    var eqHigh: Double = 0 { didSet { eq.bands[Band.high].gain = Float(eqHigh) } }

    /// -1（ローパス全開）...0（オフ）...+1（ハイパス全開）。
    var filter: Double = 0 { didSet { applyFilter() } }

    // MARK: - キュー / ループ

    var cuePoints: [CuePoint] = (0..<4).map { CuePoint(index: $0, time: 0) }
    /// 一時停止位置（CUE ボタンの戻り先）。
    private(set) var cueTime: TimeInterval = 0

    var loopLength: LoopLength = .four
    private(set) var loopEnabled = false
    private(set) var loopRange: ClosedRange<TimeInterval>?

    // MARK: - 初期化

    init(id: DeckID) {
        self.id = id
        configureEQ()
        applyTempo()
        applyGain()
    }

    private func configureEQ() {
        let low = eq.bands[Band.low]
        low.filterType = .lowShelf
        low.frequency = 120
        low.gain = 0
        low.bypass = false

        let mid = eq.bands[Band.mid]
        mid.filterType = .parametric
        mid.frequency = 1_000
        mid.bandwidth = 1.4
        mid.gain = 0
        mid.bypass = false

        let high = eq.bands[Band.high]
        high.filterType = .highShelf
        high.frequency = 6_000
        high.gain = 0
        high.bypass = false

        let filterBand = eq.bands[Band.filter]
        filterBand.filterType = .resonantLowPass
        filterBand.frequency = 20_000
        filterBand.bandwidth = 0.5
        filterBand.bypass = true

        eq.globalGain = 0
    }

    // MARK: - ロード

    /// ローカルファイルを読み込む。`analysis` と `waveform` は解析済みのものを渡す。
    func load(track: Track, url: URL, waveform: [WaveformBin]) throws {
        unload()

        let needsScope = url.startAccessingSecurityScopedResource()
        do {
            let audioFile = try AVAudioFile(forReading: url)
            self.file = audioFile
            self.scopedURL = needsScope ? url : nil
            self.track = track
            self.waveform = waveform
            let sr = audioFile.processingFormat.sampleRate
            self.duration = sr > 0 ? Double(audioFile.length) / sr : 0
            self.anchor = 0
            self.playhead = 0
            self.cueTime = 0
            self.loopEnabled = false
            self.loopRange = nil
            self.cuePoints = (0..<4).map { CuePoint(index: $0, time: 0) }
        } catch {
            if needsScope { url.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    func unload() {
        generation &+= 1
        player.stop()
        isPlaying = false
        file = nil
        track = nil
        waveform = []
        duration = 0
        playhead = 0
        anchor = 0
        if let scopedURL {
            scopedURL.stopAccessingSecurityScopedResource()
            self.scopedURL = nil
        }
    }

    /// エンジンが `player → timePitch` を接続するときに必要なフォーマット。
    var processingFormat: AVAudioFormat? { file?.processingFormat }

    // MARK: - トランスポート

    func play() {
        guard isLoaded, !isPlaying else { return }
        // 終端で止まっていたら頭から鳴らし直す。
        if playhead >= duration - 0.05 { playhead = 0 }
        if player.isPlaying == false {
            reschedule(from: playhead, resume: false)
        }
        player.play()
        isPlaying = true
    }

    func pause() {
        guard isPlaying else { return }
        let position = currentPosition()
        generation &+= 1
        player.pause()
        isPlaying = false
        playhead = position
    }

    func togglePlay() {
        isPlaying ? pause() : play()
    }

    /// CUE ボタン: 停止中はここをキュー点に設定、再生中はキュー点に戻って停止。
    func cue() {
        if isPlaying {
            pause()
            seek(to: cueTime)
        } else {
            cueTime = playhead
        }
    }

    /// CUE 長押し中のプレビュー再生。
    func previewFromCue() {
        seek(to: cueTime)
        play()
    }

    func seek(to time: TimeInterval) {
        guard isLoaded else { return }
        let clamped = min(max(0, time), max(0, duration - 0.01))
        reschedule(from: clamped, resume: isPlaying)
        playhead = clamped
    }

    /// ジョグでの微調整（秒単位）。
    func nudge(by delta: TimeInterval) {
        seek(to: currentPosition() + delta)
    }

    // MARK: - ホットキュー

    func setHotCue(_ index: Int) {
        guard cuePoints.indices.contains(index) else { return }
        cuePoints[index].time = currentPosition()
    }

    func jumpToHotCue(_ index: Int) {
        guard cuePoints.indices.contains(index) else { return }
        seek(to: cuePoints[index].time)
    }

    func clearHotCue(_ index: Int) {
        guard cuePoints.indices.contains(index) else { return }
        cuePoints[index].time = 0
    }

    // MARK: - ループ

    func toggleLoop() {
        loopEnabled ? exitLoop() : enterLoop()
    }

    /// 現在位置の直前のビートからループイン。
    func enterLoop() {
        guard isLoaded else { return }
        let position = currentPosition()
        let start = analysis.beat(atOrBefore: position) ?? position
        let beatSeconds = analysis.isUsable ? 60.0 / analysis.bpm : 0.5
        let end = start + beatSeconds * loopLength.rawValue
        guard end <= duration else { return }
        loopRange = start...end
        loopEnabled = true
        reschedule(from: max(position, start), resume: isPlaying)
    }

    func exitLoop() {
        guard loopEnabled else { return }
        let position = currentPosition()
        loopEnabled = false
        loopRange = nil
        reschedule(from: position, resume: isPlaying)
    }

    func setLoopLength(_ length: LoopLength) {
        loopLength = length
        if loopEnabled {
            exitLoop()
            enterLoop()
        }
    }

    // MARK: - 同期

    /// 相手デッキに BPM を合わせる（テンポのみ）。
    func matchTempo(to other: Deck) {
        guard analysis.isUsable, other.effectiveBPM > 0 else { return }
        tempoRatio = other.effectiveBPM / analysis.bpm
    }

    /// 相手デッキに BPM と拍の位相を合わせる。
    func sync(to other: Deck) {
        matchTempo(to: other)
        guard analysis.isUsable, other.analysis.isUsable else { return }

        let period = 60.0 / analysis.bpm
        let here = currentPosition()
        let targetPhase = other.analysis.phase(at: other.currentPosition())
        let myPhase = analysis.phase(at: here)
        var delta = (targetPhase - myPhase) * period
        // 半拍を超える補正は逆方向に回す（最短経路）。
        if delta > period / 2 { delta -= period }
        if delta < -period / 2 { delta += period }
        seek(to: here + delta)
    }

    // MARK: - 位置計算

    /// 音声レンダラの実測値から求めた現在のソース時間。
    func currentPosition() -> TimeInterval {
        guard isLoaded else { return 0 }
        guard let nodeTime = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: nodeTime),
              playerTime.sampleRate > 0 else {
            return playhead
        }
        let elapsed = Double(playerTime.sampleTime) / playerTime.sampleRate
        guard elapsed >= 0 else { return anchor }

        if loopEnabled, let range = loopRange {
            let loopLengthSeconds = range.upperBound - range.lowerBound
            if elapsed < firstSegmentLength || loopLengthSeconds <= 0 {
                return min(anchor + elapsed, duration)
            }
            let intoLoop = (elapsed - firstSegmentLength).truncatingRemainder(dividingBy: loopLengthSeconds)
            return range.lowerBound + intoLoop
        }
        return min(anchor + elapsed, duration)
    }

    /// 毎フレーム呼ばれる。表示用の値をまとめて更新する。
    func refreshPlayhead() {
        guard isLoaded else { return }
        if isPlaying {
            playhead = currentPosition()
            if !loopEnabled, playhead >= duration - 0.005 {
                pause()
                playhead = duration
            }
        }
    }

    // MARK: - スケジューリング

    private func reschedule(from position: TimeInterval, resume: Bool) {
        guard let file else { return }
        generation &+= 1
        let currentGeneration = generation

        player.stop()
        anchor = min(max(0, position), duration)

        let sampleRate = file.processingFormat.sampleRate
        guard sampleRate > 0 else { return }

        func schedule(from start: TimeInterval, to end: TimeInterval, onFinish: @escaping @MainActor () -> Void) {
            let frameStart = AVAudioFramePosition((start * sampleRate).rounded())
            let frameCount = AVAudioFrameCount(max(0, ((end - start) * sampleRate).rounded()))
            guard frameCount > 0, frameStart < file.length else { return }
            player.scheduleSegment(file,
                                   startingFrame: frameStart,
                                   frameCount: frameCount,
                                   at: nil,
                                   completionCallbackType: .dataPlayedBack) { _ in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == currentGeneration else { return }
                    onFinish()
                }
            }
        }

        if loopEnabled, let range = loopRange, anchor < range.upperBound {
            firstSegmentLength = range.upperBound - anchor
            schedule(from: anchor, to: range.upperBound) { [weak self] in self?.enqueueLoopIteration(generation: currentGeneration) }
            // 先読みで 2 周分積んでおく（つなぎ目を無音にしないため）。
            enqueueLoopIteration(generation: currentGeneration)
            enqueueLoopIteration(generation: currentGeneration)
        } else {
            firstSegmentLength = 0
            schedule(from: anchor, to: duration) { [weak self] in
                guard let self else { return }
                // 鳴らし終えたらノードも止める。止めないと `player.isPlaying` が真のままになり、
                // 次の PLAY で何もスケジュールされず無音になる。
                self.generation &+= 1
                self.player.stop()
                self.isPlaying = false
                self.playhead = self.duration
            }
        }

        if resume { player.play() }
    }

    private func enqueueLoopIteration(generation currentGeneration: Int) {
        guard generation == currentGeneration,
              loopEnabled,
              let file,
              let range = loopRange else { return }
        let sampleRate = file.processingFormat.sampleRate
        let frameStart = AVAudioFramePosition((range.lowerBound * sampleRate).rounded())
        let frameCount = AVAudioFrameCount(max(0, ((range.upperBound - range.lowerBound) * sampleRate).rounded()))
        guard frameCount > 0 else { return }
        player.scheduleSegment(file,
                               startingFrame: frameStart,
                               frameCount: frameCount,
                               at: nil,
                               completionCallbackType: .dataPlayedBack) { _ in
            Task { @MainActor [weak self] in
                self?.enqueueLoopIteration(generation: currentGeneration)
            }
        }
    }

    // MARK: - パラメータ適用

    private func applyTempo() {
        timePitch.rate = Float(min(max(0.5, tempoRatio), 2.0))
        // キーロックオフ = レコードのように音程もテンポに追従させる。
        timePitch.pitch = keyLock ? 0 : Float(1_200 * log2(tempoRatio))
    }

    private func applyGain() {
        let trim = pow(10.0, trimDB / 20.0)
        output.outputVolume = Float(min(max(0, faderLevel * crossfadeGain * trim), 4.0))
    }

    func setCrossfadeGain(_ gain: Double) {
        crossfadeGain = min(max(0, gain), 1)
        applyGain()
    }

    private func applyFilter() {
        let band = eq.bands[Band.filter]
        let amount = min(max(-1, filter), 1)
        if abs(amount) < 0.02 {
            band.bypass = true
            return
        }
        band.bypass = false
        if amount < 0 {
            // ローパス: 20kHz → 150Hz
            band.filterType = .resonantLowPass
            band.frequency = Float(20_000 * pow(150.0 / 20_000.0, Double(-amount)))
        } else {
            // ハイパス: 20Hz → 8kHz
            band.filterType = .resonantHighPass
            band.frequency = Float(20 * pow(8_000.0 / 20.0, Double(amount)))
        }
        band.bandwidth = 0.5
    }

    func resetEQ() {
        eqLow = 0
        eqMid = 0
        eqHigh = 0
        filter = 0
    }

    // MARK: - メーター

    /// `DJAudioEngine` がデッキ出力に仕掛けたタップから呼ばれる。
    nonisolated func ingestMeter(buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let frames = Int(buffer.frameLength)
        var sum: Float = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            let samples = channels[channel]
            for frame in stride(from: 0, to: frames, by: 8) {
                let value = samples[frame]
                sum += value * value
            }
        }
        let count = Float(max(1, (frames / 8) * Int(buffer.format.channelCount)))
        let rms = (sum / count).squareRoot()
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.meterCounter &+= 1
            guard self.meterCounter % 2 == 0 else { return }
            // 立ち上がりは速く、落ちはゆっくり。
            self.level = rms > self.level ? rms : self.level * 0.75 + rms * 0.25
        }
    }
}

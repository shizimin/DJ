import AVFoundation
import Foundation
import Observation
import os

/// 2 デッキ + マスターのオーディオグラフ。
///
/// ```
/// deckA.player → timePitch → eq → deckA.output ┐
///                                              ├→ master → mainMixer → output
/// deckB.player → timePitch → eq → deckB.output ┘
/// ```
///
/// エフェクトユニット（TimePitch / EQ）は入出力フォーマットを自動変換しないので、
/// 曲をロードするたびに `player → timePitch → eq → output` をファイルの
/// processingFormat で張り直す。ミキサーノードは変換してくれるため、
/// `output → master` 以降は常に標準フォーマットで固定できる。
@MainActor
@Observable
final class DJAudioEngine {
    private static let log = Logger(subsystem: "com.example.DJRig", category: "Engine")

    @ObservationIgnored let engine = AVAudioEngine()
    @ObservationIgnored let master = AVAudioMixerNode()

    let deckA = Deck(id: .a)
    let deckB = Deck(id: .b)

    let recorder = MixRecorder()

    /// マスター出力レベル（0...1、RMS）。
    private(set) var masterLevel: Float = 0
    private(set) var isRunning = false

    /// 0（A 全開）...1（B 全開）。
    var crossfaderPosition: Double = 0.5 { didSet { applyCrossfader() } }
    var crossfaderCurve: CrossfaderCurve = .constantPower { didSet { applyCrossfader() } }
    var masterGain: Double = 0.85 { didSet { master.outputVolume = Float(masterGain) } }

    @ObservationIgnored
    let standardFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!

    @ObservationIgnored private var meterCounter = 0
    // deinit（nonisolated）から触るので隔離を外しておく。
    @ObservationIgnored nonisolated(unsafe) private var configurationObserver: NSObjectProtocol?

    init() {
        buildGraph()
        applyCrossfader()
        master.outputVolume = Float(masterGain)
        observeConfigurationChanges()
    }

    deinit {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
        }
    }

    func deck(_ id: DeckID) -> Deck {
        id == .a ? deckA : deckB
    }

    // MARK: - グラフ構築

    private func buildGraph() {
        engine.attach(master)
        for deck in [deckA, deckB] {
            engine.attach(deck.player)
            engine.attach(deck.timePitch)
            engine.attach(deck.eq)
            engine.attach(deck.output)

            engine.connect(deck.player, to: deck.timePitch, format: standardFormat)
            engine.connect(deck.timePitch, to: deck.eq, format: standardFormat)
            engine.connect(deck.eq, to: deck.output, format: standardFormat)
            engine.connect(deck.output, to: master, format: standardFormat)

            deck.output.installTap(onBus: 0, bufferSize: 1_024, format: nil) { [weak deck] buffer, _ in
                deck?.ingestMeter(buffer: buffer)
            }
        }
        engine.connect(master, to: engine.mainMixerNode, format: standardFormat)

        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1_024, format: nil) { [weak self] buffer, _ in
            self?.ingestMasterMeter(buffer: buffer)
        }
    }

    /// 曲のフォーマットに合わせてデッキの前段を張り直す。
    private func rewire(_ deck: Deck) {
        guard let format = deck.processingFormat else { return }
        engine.disconnectNodeOutput(deck.player)
        engine.disconnectNodeOutput(deck.timePitch)
        engine.disconnectNodeOutput(deck.eq)
        engine.connect(deck.player, to: deck.timePitch, format: format)
        engine.connect(deck.timePitch, to: deck.eq, format: format)
        engine.connect(deck.eq, to: deck.output, format: format)
    }

    // MARK: - ライフサイクル

    func start() {
        guard !isRunning else { return }
        engine.prepare()
        do {
            try engine.start()
            isRunning = true
        } catch {
            Self.log.error("engine start failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func stop() {
        recorder.stop()
        engine.stop()
        isRunning = false
    }

    private func observeConfigurationChanges() {
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                // 出力デバイスが変わるとグラフが切断される。張り直して再開する。
                self.rewire(self.deckA)
                self.rewire(self.deckB)
                self.isRunning = false
                self.start()
            }
        }
    }

    // MARK: - ロード

    func load(track: Track, url: URL, waveform: [WaveformBin], into deckID: DeckID) throws {
        let target = deck(deckID)
        let wasRunning = isRunning
        try target.load(track: track, url: url, waveform: waveform)
        rewire(target)
        if wasRunning && !engine.isRunning { start() }
    }

    // MARK: - ミキサー

    private func applyCrossfader() {
        let gains = Crossfader.gains(position: crossfaderPosition, curve: crossfaderCurve)
        deckA.setCrossfadeGain(gains.a)
        deckB.setCrossfadeGain(gains.b)
    }

    // MARK: - 録音

    func toggleRecording() {
        if recorder.isRecording {
            recorder.stop()
        } else {
            recorder.start(on: master)
        }
    }

    // MARK: - メーター

    private nonisolated func ingestMasterMeter(buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let frames = Int(buffer.frameLength)
        var sum: Float = 0
        for channel in 0..<Int(buffer.format.channelCount) {
            let samples = channels[channel]
            for frame in stride(from: 0, to: frames, by: 8) {
                sum += samples[frame] * samples[frame]
            }
        }
        let count = Float(max(1, (frames / 8) * Int(buffer.format.channelCount)))
        let rms = (sum / count).squareRoot()
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.meterCounter &+= 1
            guard self.meterCounter % 2 == 0 else { return }
            self.masterLevel = rms > self.masterLevel ? rms : self.masterLevel * 0.75 + rms * 0.25
        }
    }
}

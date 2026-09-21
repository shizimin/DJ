# 設計メモ

## オーディオグラフ

```
deckA.player → deckA.timePitch → deckA.eq → deckA.output ┐
                                                          ├→ master → mainMixer → 出力
deckB.player → deckB.timePitch → deckB.eq → deckB.output ┘
```

- `timePitch`（`AVAudioUnitTimePitch`）: テンポ。`keyLock` オンならピッチ維持、
  オフなら `pitch = 1200 × log2(rate)` セントを与えてレコードのように音程も動かす。
- `eq`（`AVAudioUnitEQ`、4 バンド）: 0 = ローシェルフ 120Hz、1 = パラメトリック 1kHz、
  2 = ハイシェルフ 6kHz、3 = レゾナント LPF/HPF（フィルタノブ）。
  EQ のゲイン範囲は -26…+6 dB で、DJ ミキサーらしく「キル」できる。
- `output`（`AVAudioMixerNode`）: `outputVolume` にチャンネルフェーダー × クロスフェーダー ×
  トリムをまとめて掛ける。

### フォーマットの張り替え

エフェクトユニットは入出力フォーマットを変換しません。
そのため曲をロードするたびに `player → timePitch → eq → output` を
**そのファイルの `processingFormat`** で接続し直します（`DJAudioEngine.rewire`）。
ミキサーノードは変換してくれるので、`output → master → mainMixer` は常に
48kHz / 2ch 固定で置けます。

メーター用のタップは `format: nil`（＝バス自身のフォーマット）で仕掛けます。
明示フォーマットがハードウェアのサンプルレート（44.1kHz のことがある）と食い違うと
実行時に落ちるためです。

## 再生位置の求め方

```swift
elapsed = playerTime.sampleTime / playerTime.sampleRate
```

`AVAudioPlayerNode` の `sampleTime` は「ファイルから読み出したフレーム数」なので、
下流にタイムストレッチが入っていても **ソース上の経過時間**になります。
そこに「スケジュール開始時のソース時間」を足せば現在位置が出ます。

ループ中は最初のセグメント（現在位置 → ループ終端）だけ長さが違うので、
それを超えた分をループ長で剰余して折り返します（`Deck.currentPosition()`）。

## ループの繋ぎ目

`scheduleSegment` を 2 周分先読みしておき、完了コールバックのたびに 1 周分を補充します。
これで継ぎ目に無音が入りません。

`player.stop()` はキャンセルしたセグメントの完了コールバックも発火させるため、
`generation` カウンタを持たせて古いコールバックを捨てています。これがないと
シーク直後に「終わったはずのループ」が勝手に積まれます。

## BPM 推定（`BPMAnalyzer`）

1. 1 次 IIR で低 / 中 / 高の 3 帯域に分け、128 フレームごとのエネルギー差分を
   半波整流してオンセット包絡線を作る（包絡線は約 344Hz）。高域に重みを置くと
   ハイハットやスネアの粒が立ってグリッドが安定する。
2. 0.4 秒窓の移動平均を引いて、曲の音量変化に左右されないようにする。
3. 60–200 BPM に対応するラグで自己相関を取り、放物線補間でピークを小数精度にする。
4. 85–175 BPM に収まるまで 2 倍 / 1/2 して、オクターブ違いを直す。
5. その周期のコムフィルタを全位相で走らせ、最もエネルギーが乗る位置を 1 拍目にする。

信頼度は「ピーク ÷ 平均」から出していて、低いときは UI の BPM 表示が黄色くなります。

解析結果と波形は `Application Support/Analysis/<ハッシュ>.json` にキャッシュされます。
波形は Float32 の生バイト列に詰めてから保存します（JSON 配列だと肥大化するため）。

## 並行性

- 音を出す側のオブジェクト（`Deck` / `DJAudioEngine` / `AppleMusicDeck`）はすべて
  `@MainActor @Observable`。`AVAudioEngine` の API 呼び出しはリアルタイムスレッドではないので
  メインスレッドから叩いて問題ありません。
- オーディオスレッドから来るのはタップのコールバックだけで、そこでは RMS を計算して
  `Task { @MainActor in }` で渡すだけにしています（しかも 1 回おきに間引き）。
- 解析は `Task.detached(priority: .userInitiated)` で回します。

## 表示の更新

`CADisplayLink`（30–60Hz）で `Deck.refreshPlayhead()` と `AppleMusicDeck.refresh()`、
`AutoTransitionController.tick()` をまとめて呼びます。`@Observable` なので、
変わった値を読んでいるビューだけが再描画されます。

`CADisplayLink` は ObjC のターゲットを要求するので、`DisplayLinkProxy` を挟んでいます。

## 入っていないもの / 拡張ポイント

- **PFL（ヘッドホンでの事前確認）**: 内蔵出力はステレオ 2ch なので、マスターと別系統を
  ヘッドホンへ送れません。4ch 以上のオーディオインターフェイスを挿したときだけ
  `AVAudioSession.setPreferredOutputNumberOfChannels(4)` とチャンネルマッピングで実装可能。
  入り口は `DJAudioEngine.master` の手前に分岐ミキサーを足すところ。
- **MIDI**: CoreMIDI で受けて `Deck` / `DJAudioEngine` のプロパティに流すだけなので、
  モデル側の変更は不要。
- **キー検出**: `BPMAnalyzer` と同じ流し方でクロマグラムを取れば足せる。
- **エフェクト**: `eq` と `output` の間にノードを挟む。

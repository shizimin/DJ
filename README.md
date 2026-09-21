# DJRig

iPad 向けの 2 デッキ DJ アプリ（SwiftUI + AVAudioEngine + MusicKit）。

---

## 最初に読んでほしいこと — Apple Music の制約

**Apple Music のストリーミング音源で、本物の DJ ミックス（クロスフェード・EQ・スクラッチ・テンポ同期）を
行うことは、App Store で配布できる公開 API の範囲では原理的にできません。**

理由は 2 つあります。

1. **音声サンプルを取り出せない。** MusicKit で再生される曲は DRM 保護されており、
   `AVAudioEngine` に流し込むことも、タップして加工することもできません。
   EQ もフィルタもテンポ変更も、信号に触れなければ実装できません。
2. **2 曲を同時に鳴らせない。** `ApplicationMusicPlayer` は端末に 1 インスタンスしか存在せず、
   キューは 1 本だけです。デッキ A と B で別々の Apple Music 曲を同時再生することはできません。
   音量を個別に操作する API もありません。

djay などが Apple Music を直接ミックスできるのは、Apple との個別契約による特別な扱いであり、
通常の開発者アカウントでは同じことはできません。

### このアプリが取っているアプローチ

| | 音源 | できること |
|---|---|---|
| **デッキ A / B** | ローカルの音源ファイル | 本物の DJ 操作すべて。クロスフェード、3 バンド EQ + キル、レゾナントフィルタ、テンポ（キーロック付き）、ビート同期、ビートループ、ホットキュー、ジョグ、録音 |
| **Apple Music デッキ** | Apple Music（ライブラリ / カタログ） | 再生・一時停止・シーク・小節単位のジャンプ・次の曲へ。**音の加工は不可** |
| **自動つなぎ** | 両者の橋渡し | Apple Music の曲の小節頭で切り、その裏でローカルデッキを等パワーでフェードイン / アウトする |

つまり Apple Music は「かけ続けるための曲出し」、ローカル音源は「実際にこねる側」という役割分担です。
Apple Music 側の BPM は解析できないため、TAP ボタンか数値入力で手動設定します。

詳細は [`docs/APPLE_MUSIC.md`](docs/APPLE_MUSIC.md)。

---

## ビルド

必要なもの: Xcode 16 以降、iPadOS 17 以上の実機、Apple Developer アカウント。

```bash
open DJRig.xcodeproj
```

1. `DJRig` ターゲット > Signing & Capabilities で自分の Team を選び、
   `PRODUCT_BUNDLE_IDENTIFIER` を自分のものに変更する。
2. [Apple Developer](https://developer.apple.com/account/resources/identifiers/list) で、
   その App ID の **MusicKit** サービスを有効にする（これを忘れると Apple Music 側が何も返しません）。
3. iPad 実機を選んで実行する。

> シミュレータでも起動しますが、Apple Music の再生とオーディオのレイテンシは実機でしか確認できません。

Xcode プロジェクトを壊した場合は [XcodeGen](https://github.com/yonaskolb/XcodeGen) で作り直せます。

```bash
brew install xcodegen && xcodegen generate
```

## 曲の入れ方

ミックスできるのはローカルの音源ファイルだけです。入れ方は 2 通り。

- アプリ内のブラウザ > **ローカル** > 「曲を追加」から Files アプリ経由で取り込む
  （既定では `Documents/Music` にコピーされます）
- Finder / Files アプリで DJRig の `Documents/Music` に直接ドロップする
  （`UIFileSharingEnabled` を有効にしてあります）

対応形式: MP3 / M4A / AAC / WAV / AIFF / CAF / ALAC。
取り込むと BPM とビートグリッド、波形をバックグラウンドで解析し、結果はキャッシュされます。

## 操作

| 操作 | 場所 |
|---|---|
| 曲のロード | ブラウザの行にある `A` / `B` ボタン |
| 再生 / キュー | 各デッキの PLAY・CUE |
| スクラッチ / 微調整 | ジョグホイール（1 回転 ≒ 1.8 秒） |
| シーク | 俯瞰波形をタップ / ドラッグ |
| テンポ | 縦フェーダー（±8%）。KEY でキーロック切替 |
| ビート同期 | SYNC（MASTER に指定したデッキへ BPM と拍位相を合わせる） |
| ビートループ | 拍数を選んで LOOP IN。現在位置の直前の拍から鳴り続けます |
| ホットキュー | 4 つ。空ならその場で設定、設定済みならジャンプ。長押しで上書き / 消去 |
| EQ / フィルタ | 中央ミキサーのノブ（縦ドラッグ、ダブルタップでリセット） |
| クロスフェーダー | 中央下。カーブは Smooth / Linear / Sharp |
| 録音 | マスターの REC。`Documents` に CAF で保存されます |

## 録音について

録音されるのは **このアプリのエンジンが鳴らしている音（ローカルデッキ）だけ** です。
Apple Music の音は OS の別プロセスで再生されていて取得できませんし、
DRM 保護を回避するような実装は行いません。

## 構成

```
DJRig/
  App/        アプリ本体とアプリ全体の状態、60Hz のティッカー
  Audio/      AVAudioEngine のグラフ、デッキ、クロスフェーダー、録音
  Analysis/   BPM / ビートグリッド推定、波形生成、解析キャッシュ
  Library/    ローカルライブラリ、MusicKit、Apple Music デッキ、自動つなぎ
  Model/      Track / TrackAnalysis / CuePoint
  UI/         SwiftUI ビューと自作コントロール（ノブ、フェーダー、ジョグ、波形）
```

設計の詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 現時点で入っていないもの

- **ヘッドホンでの事前確認（PFL / スプリットキュー）** — 内蔵出力はステレオ 2ch しかなく、
  「マスターとは別の音をヘッドホンに送る」ことができません。4ch 以上の USB オーディオ
  インターフェイスを iPad に挿した場合のみ実装可能で、今回は入れていません。
- MIDI コントローラ対応（CoreMIDI）
- キー（調）検出とハーモニックミキシング
- エフェクト（ディレイ / リバーブ / ローラー）

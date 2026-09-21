# Apple Music を DJ に使うときに何ができて何ができないか

## 結論

Apple Music の音源を 2 デッキに載せて本当にミックスすることは、公開 API ではできません。
このドキュメントは「なぜできないのか」と「代わりに何をしているか」を残すためのものです。

## できないこと

### 1. 音声サンプルにアクセスできない

MusicKit が再生するカタログ / ライブラリの曲は FairPlay で保護されています。

- `MPMediaItem.assetURL` は、Apple Music からダウンロードした曲では `nil` を返す
  （`nil` でないのは iTunes Store で購入した DRM フリーの曲か、自分で同期した曲だけ）
- `ApplicationMusicPlayer` の出力を `AVAudioEngine` に取り込む API は存在しない
- プロセス内で出力をタップする手段もない

結果として、**EQ・フィルタ・タイムストレッチ・スクラッチ・音量カーブ**はすべて実装不能です。
これらは信号に触れることが前提の処理だからです。

### 2. 2 曲を同時に鳴らせない

`ApplicationMusicPlayer.shared` はシングルトンで、キューは 1 本です。
2 つ目のインスタンスを作ることはできず、`SystemMusicPlayer` も同じ再生スタックを共有します。
したがって「デッキ A で曲 1、デッキ B で曲 2」を Apple Music の曲同士で行うことはできません。

### 3. 音量を個別に操作できない

`ApplicationMusicPlayer` に音量プロパティはありません。操作できるのはシステム音量だけで、
それはアプリ全体（自前のエンジンの音も含む）に等しくかかるため、
クロスフェードには使えません。

### 4. 録音できない

Apple Music の音は OS の別プロセスで再生されるため、アプリのミックス録音には入りません。
これを迂回する実装は DRM 保護の回避にあたるので、このプロジェクトでは行いません。

### djay はなぜできているのか

Algoriddim の djay は Apple との個別契約に基づく特別な扱いを受けています。
通常の開発者アカウントで同じ API が開放されることはありません。

## できること

`MusicKitService` と `AppleMusicDeck` が実際に使っている API の範囲です。

| やること | API |
|---|---|
| 認証 | `MusicAuthorization.request()` |
| サブスク確認 | `MusicSubscription.current` / `subscriptionUpdates` |
| ライブラリ検索 | `MusicLibrarySearchRequest(term:types:)` |
| カタログ検索 | `MusicCatalogSearchRequest(term:types:)` |
| プレイリスト | `MusicLibraryRequest<Playlist>` + `playlist.with([.tracks])` |
| キュー設定 | `ApplicationMusicPlayer.shared.queue = [song]` |
| 再生 / 停止 | `play()` / `pause()` / `stop()` |
| シーク | `player.playbackTime = t` |
| 曲送り | `skipToNextEntry()` |
| 状態取得 | `player.state.playbackStatus`, `player.queue.currentEntry` |

## このアプリでの使い方

### 役割分担

- **Apple Music デッキ** = 曲を「かけ続ける」側。加工しない。
- **ローカルデッキ A / B** = 実際にこねる側。フェード・EQ・テンポ・ループが効く。

### BPM は手入力

音声を解析できないので、Apple Music デッキの BPM は次のどちらかで決めます。

- **TAP** ボタンを 4 回以上叩く（直近 8 回の平均から算出）
- 数値を直接入れる（ステッパーで 0.1 刻み）

**拍頭**ボタンを押すと、その瞬間の再生位置を 1 拍目として登録し直します。
これで小節グリッドが決まり、自動つなぎの吸着先になります。

### 自動つなぎ（`AutoTransitionController`）

Apple Music 側の音量を操作できないので、フェードは**ローカルデッキ側だけ**で作ります。

```
Apple Music:  ────────────────────────┤ 小節頭でカット（一時停止）
ローカルデッキ:           0 ──────── 1 │ 等パワーでフェードイン
                          └ fadeBars 小節 ┘
```

1. `arm(afterBars:)` か `armBeforeEnd(bars:)` でカット位置を予約する。
   位置は手入力した BPM のグリッドで小節頭に吸着される。
2. `カット位置 − フェード長` に達したら、ローカルデッキをその直前の拍から再生開始し、
   フェーダーを `sin(進捗 × π/2)` で 0 → 1 に上げる。
3. カット位置で Apple Music を一時停止する。

逆方向（ローカル → Apple Music）も同じで、ローカル側を `cos` カーブでフェードアウトし、
カット位置で止めます。

Apple Music 側は音量を絞れないため、**切り替わりは必ず「カット」になります**。
小節頭に合わせているので、曲が合っていれば実用上は破綻しません。

## 純粋に Apple Music だけで DJ したい場合

このアプリの範囲では無理です。選択肢は次のどれかになります。

1. **曲をローカルファイルとして持つ。** 購入した DRM フリーの音源、自分のライブラリ、
   配信サイトで買った WAV / AIFF など。これならすべての機能が使えます。
2. **Algoriddim djay を使う。** Apple との契約により Apple Music を直接ミックスできます。
3. **外部ミキサーを使う。** iPad の音声出力（Apple Music）を物理ミキサーの 1ch に入れ、
   もう 1ch に別のソースを入れて手で混ぜる。アプリ側の制約とは無関係になります。

# CSP AI Bridge

**CLIP STUDIO PAINT** から **Nano Banana Pro (Gemini 3 Pro Image)** と **GPT Image (OpenAI)** を使うためのコンパニオンアプリです。

CLIP STUDIO PAINT には AI API を直接呼べるスクリプト / 拡張機能の仕組みがありません (公式 Plugin SDK は C++ のフィルター用のみ)。
そこでこのアプリは CSP の横に **常に最前面の小さなパネル** として置き、**クリップボード経由**で画像をやり取りします。

```
CSP で範囲を選択 → Ctrl+C ──▶ [CSP AI Bridge] 指示を入力して「生成」
                                          │  Nano Banana Pro / GPT Image
CSP で Ctrl+V (新規レイヤーに貼り付け) ◀── 結果を自動でクリップボードへ
```

## できること

| 機能 | Nano Banana Pro | GPT Image |
|---|---|---|
| テキストから新規生成 | ✅ | ✅ |
| 画像の編集 (着色・清書・描き足しなど) | ✅ | ✅ |
| 参考画像を複数枚渡す (画風・キャラの参照) | ✅ (最大 14 枚) | ✅ |
| マスクで範囲指定して描き直し | ✅ (マスク画像+指示文で指定) | ✅ (API のマスク機能) |
| 出力解像度 / 縦横比 | 1K / 2K / 4K・各種比率 | auto / 1024² / 1536×1024 / 1024×1536 |
| 透過背景 | – | ✅ `background=transparent` |

- 結果は **元画像と同じサイズに自動リサイズ** されるので、キャンバス全体をコピーした場合は貼り付け位置がぴったり揃います。
- 生成画像は自動で `~/Pictures/CSP-AI-Bridge/` に PNG 保存されます。
- 「入力に使う」で結果をそのまま次の編集の元画像にでき、繰り返し修正できます。
- 着色・清書・背景追加などのプロンプトプリセット付き。

## セットアップ

1. Python 3.9 以上をインストール (Windows は [python.org](https://www.python.org/downloads/) 版。tkinter が同梱されています)。
2. このフォルダで起動:
   - **Windows**: `run_windows.bat` をダブルクリック
   - **macOS**: `run_mac.command` をダブルクリック
   - 手動: `pip install -r requirements.txt` → `python -m csp_ai_bridge`
3. 右上の「設定」で API キーを入力。
   - Gemini: <https://aistudio.google.com/apikey> (Nano Banana Pro は有料枠が必要です)
   - OpenAI: <https://platform.openai.com/api-keys> (GPT Image は組織の認証が必要な場合があります)
   - 環境変数 `GEMINI_API_KEY` / `OPENAI_API_KEY` でも可。

## 使い方

1. CSP で編集したい範囲を選択し **編集 → コピー (Ctrl+C)**。
2. CSP AI Bridge で **「📋 クリップボードから追加」**。2 回目以降に追加した画像は参考画像になります。
3. 指示を書いて **✨ 生成** (Ctrl+Enter)。
4. 完了すると結果が自動でクリップボードに入るので、CSP で **Ctrl+V** → 新規レイヤーとして貼り付けられます。

### キャンバス全体を送るには (オートアクション推奨)

CSP の「コピー」は選択中のレイヤーだけが対象です。全レイヤーを合成した状態で送りたい場合は、次の手順を **オートアクション** に登録してショートカットキーを割り当てると 1 キーで済みます。

1. レイヤー → **表示レイヤーのコピーを結合**
2. 選択範囲 → **すべてを選択**
3. 編集 → **コピー**
4. レイヤー → **レイヤーを削除**
5. 選択範囲 → **選択を解除**

### マスクで一部だけ描き直す

1. CSP で新規レイヤーを作り、描き直したい範囲を **任意の色で塗りつぶす** (その他は透明または白)。
2. そのレイヤーをコピーして **「📋 マスクを取り込み」**。
3. 元画像を追加し、指示 (例: 「右手にコーヒーカップを持たせて」) を書いて生成。

マスクは「透明度がある画像なら不透明部分」「透明度がない画像なら白以外の部分」を編集範囲として扱います。

## モデル名について

モデル名は入力欄で自由に書き換えられます (新しいモデルが出たらそのまま使えます)。

- Nano Banana Pro: `gemini-3-pro-image-preview` (既定) / Nano Banana: `gemini-2.5-flash-image`
- GPT Image: `gpt-image-2` (既定) / `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare` / `gpt-image-1`

API URL も設定で変更できるので、互換 API やプロキシ経由でも使えます。

## 注意

- API の利用料金はそれぞれのサービスで発生します。
- アップロード画像は長辺 2048px に縮小して送信します (設定で変更可)。
- API キーは `~/.csp_ai_bridge/config.json` に保存されます (本人のみ読み書き可に設定)。
- クリップボードへの書き込みは Windows では CF_DIB / CF_DIBV5 (透過付き) / PNG、macOS では PNG を使います。

## 開発

```bash
pip install Pillow pytest
python -m pytest tests
```

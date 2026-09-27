#!/bin/bash
# Nuri を起動する (Finder でダブルクリック)。初回だけ準備に 1〜2 分かかります。
cd "$(dirname "$0")"
if ! command -v npm >/dev/null 2>&1; then
  osascript -e 'display dialog "Node.js が必要です。https://nodejs.org からインストールしてから、もう一度開いてください。" buttons {"OK"} with icon caution'
  open "https://nodejs.org/ja/download"
  exit 1
fi
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "準備中 (npm install)…"
  npm install --no-audit --no-fund || exit 1
fi
if [ ! -d dist ] || [ -n "$(find src index.html -newer dist -print -quit)" ]; then
  echo "ビルド中…"
  npm run build || exit 1
fi
echo "Nuri を開きます: http://localhost:5178  (終了するにはこのウィンドウを閉じてください)"
npx vite preview --port 5178 --open

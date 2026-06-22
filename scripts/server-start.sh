#!/usr/bin/env bash
# SurveyTool サーバー起動スクリプト
# 使い方: bash start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
PORT=8002

echo "============================================"
echo "  SurveyTool 起動"
echo "============================================"

# Python3 を探す
if command -v python3 &>/dev/null; then
  PYTHON="python3"
elif command -v python &>/dev/null; then
  PYTHON="python"
else
  echo "[エラー] Python3 が見つかりません。"
  echo "  https://www.python.org からインストールしてください。"
  exit 1
fi

# 仮想環境セットアップ（初回のみ）
if [ ! -f "$VENV_DIR/bin/python3" ]; then
  echo "==> 初回セットアップ: 仮想環境を作成しています..."
  "$PYTHON" -m venv "$VENV_DIR"
  echo "==> 依存ライブラリをインストールしています（数分かかります）..."
  "$VENV_DIR/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"
  echo "==> セットアップ完了"
fi

echo ""
echo "==> サーバーを起動しています... http://127.0.0.1:$PORT"
echo "    ブラウザで上記 URL を開いてください。"
echo "    終了するには Ctrl+C を押してください。"
echo ""

# ブラウザを遅延オープン（サーバー起動待ち）
(sleep 2 && open "http://127.0.0.1:$PORT" 2>/dev/null || true) &

cd "$SCRIPT_DIR"
"$VENV_DIR/bin/python3" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"

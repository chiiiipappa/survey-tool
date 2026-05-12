#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
  echo "=== 仮想環境を作成します ==="
  python3 -m venv .venv
fi

source .venv/bin/activate

echo "=== 依存パッケージをインストールします ==="
pip install -q -r requirements.txt

echo "=== サーバーを起動します (http://localhost:8002) ==="
uvicorn app.main:app --host 127.0.0.1 --port 8002 --reload --reload-dir app

#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  サーベイBIツール 起動中..."
echo "============================================"
echo ""

# Python3 の存在確認
if ! command -v python3 &> /dev/null; then
  echo "[エラー] Python3 が見つかりません。"
  echo "         https://www.python.org からインストールしてください。"
  echo ""
  read -r -p "Enterキーで閉じます..."
  exit 1
fi

# 仮想環境の作成
if [ ! -d ".venv" ]; then
  echo "[1/3] 仮想環境を作成しています..."
  python3 -m venv .venv
  if [ $? -ne 0 ]; then
    echo "[エラー] 仮想環境の作成に失敗しました。"
    read -r -p "Enterキーで閉じます..."
    exit 1
  fi
fi

source .venv/bin/activate

echo "[2/3] ライブラリをインストールしています（初回のみ時間がかかります）..."
pip install -q -r requirements.txt
if [ $? -ne 0 ]; then
  echo "[エラー] ライブラリのインストールに失敗しました。"
  echo "         インターネット接続を確認してください。"
  read -r -p "Enterキーで閉じます..."
  exit 1
fi

echo "[3/3] サーバーを起動しています..."
echo ""
echo "ブラウザが自動で開きます。"
echo "開かない場合は http://localhost:8002 にアクセスしてください。"
echo ""
echo "ツールを終了するには Ctrl+C を押してください。"
echo "============================================"
echo ""

# サーバーが起動したらブラウザを自動オープン
(
  until curl -s http://127.0.0.1:8002 > /dev/null 2>&1; do
    sleep 0.5
  done
  open http://localhost:8002
) &

uvicorn app.main:app --host 127.0.0.1 --port 8002

echo ""
echo "サーバーが停止しました。"

@echo off
cd /d %~dp0

if not exist .venv (
    echo === 仮想環境を作成します ===
    python -m venv .venv
)

call .venv\Scripts\activate

echo === 依存パッケージをインストールします ===
pip install -q -r requirements.txt

echo === サーバーを起動します (http://localhost:8002) ===
uvicorn app.main:app --host 127.0.0.1 --port 8002 --reload --reload-dir app

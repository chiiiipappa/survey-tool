@echo off
chcp 65001 > nul
cd /d %~dp0

echo ============================================
echo   サーベイBIツール 起動中...
echo ============================================
echo.

if not exist .venv (
    echo [1/3] 仮想環境を作成しています...
    python -m venv .venv
    if errorlevel 1 (
        echo.
        echo [エラー] Python が見つかりません。
        echo         https://www.python.org からインストールしてください。
        echo         インストール時に "Add Python to PATH" にチェックを入れてください。
        echo.
        pause
        exit /b 1
    )
)

call .venv\Scripts\activate

echo [2/3] ライブラリをインストールしています（初回のみ時間がかかります）...
pip install -q -r requirements.txt
if errorlevel 1 (
    echo.
    echo [エラー] ライブラリのインストールに失敗しました。
    echo         インターネット接続を確認してください。
    echo.
    pause
    exit /b 1
)

echo [3/3] サーバーを起動しています...
echo.
echo ブラウザが自動で開きます。
echo 開かない場合は http://localhost:8002 にアクセスしてください。
echo.
echo ツールを終了するには、このウィンドウで Ctrl+C を押してください。
echo ============================================
echo.

start "" "http://localhost:8002"
uvicorn app.main:app --host 127.0.0.1 --port 8002

echo.
echo サーバーが停止しました。
pause

#!/usr/bin/env bash
# 配布用パッケージを一括生成する。
#   ./scripts/build-release.sh だけで release/ 配下に
#   SurveyTool-Windows.zip / SurveyTool-Mac.zip / SurveyTool-Server.zip / README.txt が出来上がる。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================"
echo "  SurveyTool 配布パッケージ生成"
echo "============================================"

echo ""
echo "==> [1/5] npm install"
npm install

echo ""
echo "==> [2/5] npm run build"
npm run build

echo ""
echo "==> [3/5] electron-builder (Windows exe + Mac dmg)"
npx electron-builder -mw

echo ""
echo "==> [4/5] release/ フォルダを作成しています"
rm -rf release
mkdir -p release

WIN_EXE="$(find dist -maxdepth 1 -name '*.exe' | head -n1)"
MAC_DMG="$(find dist -maxdepth 1 -name '*.dmg' | head -n1)"

if [ -z "$WIN_EXE" ]; then
  echo "[エラー] Windows用インストーラ (dist/*.exe) が見つかりません。" >&2
  exit 1
fi
if [ -z "$MAC_DMG" ]; then
  echo "[エラー] Mac用インストーラ (dist/*.dmg) が見つかりません。" >&2
  exit 1
fi

TMP_WIN="$(mktemp -d)"
TMP_MAC="$(mktemp -d)"
TMP_SRV="$(mktemp -d)"
trap 'rm -rf "$TMP_WIN" "$TMP_MAC" "$TMP_SRV"' EXIT

cp "$WIN_EXE" "$TMP_WIN/"
cp "$MAC_DMG" "$TMP_MAC/"

( cd "$TMP_WIN" && zip -r -q "$ROOT_DIR/release/SurveyTool-Windows.zip" . )
( cd "$TMP_MAC" && zip -r -q "$ROOT_DIR/release/SurveyTool-Mac.zip" . )

echo ""
echo "==> [5/5] ターミナル起動用サーバーZIPを作成しています"
SRV_DIR="$TMP_SRV/SurveyTool-Server"
mkdir -p "$SRV_DIR"
cp -r app "$SRV_DIR/"
cp -r static "$SRV_DIR/"
cp -r sample_data "$SRV_DIR/"
cp requirements.txt "$SRV_DIR/"
cp scripts/server-start.sh "$SRV_DIR/start.sh"
chmod +x "$SRV_DIR/start.sh"
( cd "$TMP_SRV" && zip -r -q "$ROOT_DIR/release/SurveyTool-Server.zip" SurveyTool-Server )

cp README.txt release/README.txt

echo ""
echo "============================================"
echo "  完了: release/ に配布用ファイルを生成しました"
echo "============================================"
ls -la release

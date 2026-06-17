#!/usr/bin/env python3
"""
配布用パッケージ生成スクリプト。

使い方:
  python3 build_release.py --format zip    # ZIP形式のみ（Mac用・Windows用）
  python3 build_release.py --format app    # アプリ形式のみ（.dmg / .exe）
  python3 build_release.py --format all    # 両方生成
  python3 build_release.py                 # デフォルト: zip

出力先: release/
  survey-tool-mac.zip        ZIP形式（Mac用）
  survey-tool-windows.zip    ZIP形式（Windows用）
  SurveyTool-Mac.zip         アプリ形式（DMG入り）
  SurveyTool-Windows.zip     アプリ形式（EXE入り）
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import stat
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).parent
DEST = ROOT / "release"

# ────────────────────────────────────────────────
# 除外ルール（ZIP 共通）
# ────────────────────────────────────────────────
EXCLUDE_DIRS = {
    "__pycache__", ".venv", ".git", ".claude",
    "tests", ".pytest_cache", "release", "dist",
    "node_modules", "electron",
}
EXCLUDE_FILES = {
    ".DS_Store", "build_release.py",
    "start.sh", "start.bat",
    "run.command", "run.bat",
    "app.code-workspace",
}
EXCLUDE_EXTS = {".pyc", ".pyo", ".log", ".tmp"}

# ZIP に含めるディレクトリ・ファイル
ZIP_INCLUDE_DIRS = ["app", "static", "sample_data"]
ZIP_INCLUDE_FILES = ["requirements.txt"]


# ────────────────────────────────────────────────
# ZIP 専用 README
# ────────────────────────────────────────────────
ZIP_README = """\
====================================================
 SurveyTool（サーベイBIツール）ZIP 配布版
====================================================

このZIPはインストール不要の配布版です。
解凍してから、以下の手順で起動してください。

----------------------------------------------------
起動方法
----------------------------------------------------

【Windows の場合】
  解凍したフォルダの中の start_windows.bat をダブルクリックしてください。

【Mac の場合】
  1. 解凍したフォルダの中の start_mac.command を右クリック
  2.「開く」を選択
  3. セキュリティ確認ダイアログが出たら「開く」をクリック

----------------------------------------------------
事前準備（Python のインストール）
----------------------------------------------------

このZIP版を動かすには Python（バージョン3.10以上）が必要です。
すでに入っている場合は不要です。

  https://www.python.org/ からダウンロードしてインストールしてください。

  Windows の場合：インストール時に「Add Python to PATH」にチェックを入れてください。

----------------------------------------------------
初回起動について
----------------------------------------------------

初回起動時はインターネット接続が必要です。
必要なライブラリを自動でインストールするため、数分かかる場合があります。
2回目以降はオフラインでも動作します。

----------------------------------------------------
セキュリティ警告が出た場合
----------------------------------------------------

Windows の場合：
  「WindowsによってPCが保護されました」と表示された場合、
  「詳細情報」→「実行」をクリックして進めてください。

Mac の場合：
  「開発元を確認できません」と表示された場合、
  start_mac.command を右クリック→「開く」→「開く」で起動できます。

----------------------------------------------------
注意事項
----------------------------------------------------

・このツールはお使いのパソコンの中だけで動作します
・入力データがインターネット経由で外部に送信されることはありません
・配布元が信頼できる相手であることを確認してから実行してください

====================================================
"""


# ────────────────────────────────────────────────
# 共通ユーティリティ
# ────────────────────────────────────────────────

def should_exclude(path: pathlib.Path) -> bool:
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True
    if path.name in EXCLUDE_FILES:
        return True
    if path.suffix in EXCLUDE_EXTS:
        return True
    return False


def _add_dir_to_zip(zf: zipfile.ZipFile, src_dir: pathlib.Path,
                    arcdir: str) -> int:
    """ディレクトリ以下のファイルを ZIP に追加し、追加数を返す。"""
    added = 0
    for f in sorted(src_dir.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(ROOT)
        if should_exclude(rel):
            continue
        arcname = f"{arcdir}/{f.relative_to(src_dir)}"
        zf.write(f, arcname)
        print(f"  追加: {arcname}")
        added += 1
    return added


def _check_prereqs_zip() -> bool:
    """ZIP 生成に必要なファイルが揃っているか確認する。"""
    missing = [d for d in ZIP_INCLUDE_DIRS if not (ROOT / d).is_dir()]
    missing += [f for f in ZIP_INCLUDE_FILES if not (ROOT / f).is_file()]
    if missing:
        print("[エラー] 以下のファイル/ディレクトリが見つかりません:")
        for m in missing:
            print(f"  - {m}")
        return False
    return True


# ────────────────────────────────────────────────
# ZIP 形式ビルド
# ────────────────────────────────────────────────

def _build_zip_platform(
    zipout: pathlib.Path,
    top_dir: str,
    startup_arcname: str,
    startup_src: pathlib.Path | None,
) -> bool:
    """指定プラットフォーム向けの ZIP を生成する共通処理。"""
    DEST.mkdir(exist_ok=True)
    if zipout.exists():
        zipout.unlink()
        print(f"  既存ファイルを削除: {zipout.name}")

    added = 0
    try:
        with zipfile.ZipFile(zipout, "w", zipfile.ZIP_DEFLATED) as zf:
            # ディレクトリ
            for d in ZIP_INCLUDE_DIRS:
                src = ROOT / d
                if src.is_dir():
                    added += _add_dir_to_zip(zf, src, f"{top_dir}/{d}")

            # ファイル
            for fname in ZIP_INCLUDE_FILES:
                src = ROOT / fname
                if src.is_file():
                    arcname = f"{top_dir}/{fname}"
                    zf.write(src, arcname)
                    print(f"  追加: {arcname}")
                    added += 1

            # 起動スクリプト（run.command / run.bat の内容をリネームして格納）
            if startup_src and startup_src.is_file():
                arcname = f"{top_dir}/{startup_arcname}"
                info = zipfile.ZipInfo(arcname)
                # Mac の .command に実行権限を付与
                if startup_arcname.endswith(".command"):
                    info.external_attr = (
                        stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP |
                        stat.S_IROTH | stat.S_IXOTH
                    ) << 16
                content = startup_src.read_bytes()
                zf.writestr(info, content)
                print(f"  追加: {arcname}")
                added += 1

            # ZIP 専用 README
            readme_arcname = f"{top_dir}/README.txt"
            zf.writestr(readme_arcname, ZIP_README.encode("utf-8"))
            print(f"  追加: {readme_arcname}")
            added += 1

    except Exception as e:
        print(f"[エラー] ZIP 生成中に失敗しました: {e}")
        return False

    size_kb = zipout.stat().st_size // 1024
    print(f"  → {zipout.name}  ({size_kb:,} KB, {added} ファイル)")
    return True


def build_zip_mac(root: pathlib.Path, dest: pathlib.Path) -> bool:
    print("\n--- ZIP (Mac) を生成しています ---")
    return _build_zip_platform(
        zipout=dest / "survey-tool-mac.zip",
        top_dir="survey-tool-mac",
        startup_arcname="start_mac.command",
        startup_src=root / "run.command",
    )


def build_zip_windows(root: pathlib.Path, dest: pathlib.Path) -> bool:
    print("\n--- ZIP (Windows) を生成しています ---")
    return _build_zip_platform(
        zipout=dest / "survey-tool-windows.zip",
        top_dir="survey-tool-windows",
        startup_arcname="start_windows.bat",
        startup_src=root / "run.bat",
    )


# ────────────────────────────────────────────────
# アプリ形式ビルド
# ────────────────────────────────────────────────

def build_app(root: pathlib.Path) -> bool:
    print("\n--- アプリ形式 (.dmg / .exe) を生成しています ---")

    if not shutil.which("npm"):
        print("[エラー] npm コマンドが見つかりません。")
        print("         Node.js をインストールしてから再試行してください。")
        print("         https://nodejs.org/")
        return False

    script = root / "scripts" / "build-release.sh"
    if not script.exists():
        print(f"[エラー] ビルドスクリプトが見つかりません: {script}")
        return False

    result = subprocess.run(["bash", str(script)], cwd=root)
    if result.returncode != 0:
        print(f"[エラー] アプリ形式のビルドに失敗しました (終了コード: {result.returncode})")
        return False
    return True


# ────────────────────────────────────────────────
# メイン
# ────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="SurveyTool 配布パッケージ生成スクリプト",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使い方:
  python3 build_release.py --format zip    ZIP形式のみ（Mac用・Windows用）
  python3 build_release.py --format app    アプリ形式のみ（.dmg / .exe）
  python3 build_release.py --format all    両方生成
  python3 build_release.py                 デフォルト: zip
        """,
    )
    parser.add_argument(
        "--format",
        choices=["zip", "app", "all"],
        default="zip",
        help="生成する配布形式 (default: zip)",
    )
    args = parser.parse_args()

    print("=" * 52)
    print("  SurveyTool 配布パッケージ生成")
    print(f"  形式: {args.format}")
    print("=" * 52)

    if args.format in ("zip", "all"):
        if not _check_prereqs_zip():
            sys.exit(1)

    results: dict[str, bool] = {}

    if args.format in ("zip", "all"):
        results["survey-tool-mac.zip"]     = build_zip_mac(ROOT, DEST)
        results["survey-tool-windows.zip"] = build_zip_windows(ROOT, DEST)

    if args.format in ("app", "all"):
        results["アプリ形式 (.dmg / .exe)"] = build_app(ROOT)

    # ────── サマリ ──────
    print("\n" + "=" * 52)
    print("  生成結果")
    print("=" * 52)
    all_ok = True
    for name, ok in results.items():
        mark = "✓" if ok else "✗"
        print(f"  {mark}  {name}")
        if ok and (DEST / name).exists():
            size_kb = (DEST / name).stat().st_size // 1024
            print(f"       → {DEST / name}  ({size_kb:,} KB)")
        if not ok:
            all_ok = False

    print("=" * 52)
    if not all_ok:
        print("  一部の生成に失敗しました。上記のエラーを確認してください。")
        sys.exit(1)
    else:
        print("  すべて正常に生成されました。")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
配布用パッケージ生成スクリプト。

使い方:
  python3 build_release.py --format zip    # ZIP形式のみ（Mac用・Windows用）
  python3 build_release.py --format app    # アプリ形式のみ（.dmg / .exe）
  python3 build_release.py --format all    # 両方生成
  python3 build_release.py                 # デフォルト: zip

出力先: release/
  README.txt                 生成内容に合わせた説明書
  survey-tool-mac.zip        ZIP形式（Mac用）
  survey-tool-windows.zip    ZIP形式（Windows用）
  survey-tool-mac.dmg        アプリ形式（Mac用）
  survey-tool-windows.exe    アプリ形式（Windows用）
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

ZIP_INCLUDE_DIRS  = ["app", "static", "sample_data"]
ZIP_INCLUDE_FILES = ["requirements.txt"]


# ────────────────────────────────────────────────
# ZIP 内部 README（起動スクリプト方式の説明）
# ────────────────────────────────────────────────
_ZIP_README = """\
====================================================
 SurveyTool（サーベイBIツール）ZIP 配布版
====================================================

このZIPはインストール不要の配布版です（起動スクリプト方式）。
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
ターミナルから起動する方法（セキュリティでブロックされた場合）
----------------------------------------------------

ダブルクリックで起動できない場合は、ターミナルから以下の手順で起動できます。

【Mac の場合】
  1. ターミナルを開く（Launchpad →「ターミナル」で検索）
  2. 以下を入力して解凍フォルダに移動：
       cd ~/Downloads/survey-tool-mac
     ※ 解凍先が異なる場合はパスを変更してください
  3. 以下のコマンドを実行：
       bash start_mac.command

【Windows の場合】
  1. コマンドプロンプトを開く（スタートメニュー →「cmd」で検索 → Enter）
  2. 以下を入力して解凍フォルダに移動：
       cd C:\\Users\\(ユーザー名)\\Downloads\\survey-tool-windows
     ※ 解凍先が異なる場合はパスを変更してください
  3. 以下のコマンドを実行：
       start_windows.bat

----------------------------------------------------
注意事項
----------------------------------------------------

・このツールはお使いのパソコンの中だけで動作します
・入力データがインターネット経由で外部に送信されることはありません
・配布元が信頼できる相手であることを確認してから実行してください

====================================================
"""


# ────────────────────────────────────────────────
# release/README.txt（実際の生成物に合わせて動的に作成）
# ────────────────────────────────────────────────
def _make_release_readme(has_zip: bool, has_app: bool) -> str:
    lines = [
        "====================================================",
        " SurveyTool（サーベイBIツール）配布パッケージ",
        "====================================================",
        "",
    ]
    if has_zip and has_app:
        lines += ["このフォルダには2種類の配布形式が含まれています。", ""]

    if has_app:
        lines += [
            "----------------------------------------------------",
            "【アプリ形式】インストーラで使う方へ",
            "----------------------------------------------------",
            "",
            "■ Windows の方",
            "  survey-tool-windows.exe をダブルクリックしてください。",
            "  「Windows によって PC が保護されました」が出た場合は、",
            "  「詳細情報」→「実行」をクリックしてください。",
            "",
            "■ Mac の方",
            "  survey-tool-mac.dmg をダブルクリックして開き、",
            "  SurveyTool アイコンを Applications フォルダにドラッグしてください。",
            "  「開発元を確認できません」が出た場合は、",
            "  右クリック→「開く」→「開く」をクリックしてください。",
            "",
        ]

    if has_zip:
        lines += [
            "----------------------------------------------------",
            "【ZIP版】インストール不要で使う方へ（Python が必要）",
            "----------------------------------------------------",
            "",
            "■ Windows の方",
            "  survey-tool-windows.zip を展開し、",
            "  start_windows.bat をダブルクリックしてください。",
            "  ブロックされた場合：コマンドプロンプト（cmd）を開いて実行：",
            "    cd C:\\Users\\(ユーザー名)\\Downloads\\survey-tool-windows",
            "    start_windows.bat",
            "",
            "■ Mac の方",
            "  survey-tool-mac.zip を展開し、",
            "  start_mac.command を右クリック→「開く」→「開く」で起動してください。",
            "  ブロックされた場合：ターミナルを開いて実行：",
            "    cd ~/Downloads/survey-tool-mac",
            "    bash start_mac.command",
            "",
            "※ ZIP版の起動には Python（3.10以上）が必要です。",
            "   https://www.python.org/",
            "   Windows の場合：インストール時に「Add Python to PATH」にチェック。",
            "",
            "※ 初回起動時はインターネット接続が必要です（ライブラリの自動インストール）。",
            "",
        ]

    lines += [
        "====================================================",
        "このツールはお使いのパソコンの中だけで動作します。",
        "データが外部に送信されることはありません。",
        "====================================================",
    ]
    return "\n".join(lines) + "\n"


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


# ────────────────────────────────────────────────
# ZIP 形式ビルド
# ────────────────────────────────────────────────

def _build_zip_platform(
    zipout: pathlib.Path,
    top_dir: str,
    startup_arcname: str,
    startup_src: pathlib.Path | None,
) -> bool:
    DEST.mkdir(exist_ok=True)
    if zipout.exists():
        zipout.unlink()

    added = 0
    try:
        with zipfile.ZipFile(zipout, "w", zipfile.ZIP_DEFLATED) as zf:
            for d in ZIP_INCLUDE_DIRS:
                src = ROOT / d
                if src.is_dir():
                    added += _add_dir_to_zip(zf, src, f"{top_dir}/{d}")

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
                if startup_arcname.endswith(".command"):
                    info.external_attr = (
                        stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP |
                        stat.S_IROTH | stat.S_IXOTH
                    ) << 16
                zf.writestr(info, startup_src.read_bytes())
                print(f"  追加: {arcname}")
                added += 1

            # ZIP 専用 README
            readme_arcname = f"{top_dir}/README.txt"
            zf.writestr(readme_arcname, _ZIP_README.encode("utf-8"))
            print(f"  追加: {readme_arcname}")
            added += 1

    except Exception as e:
        print(f"  [エラー] ZIP 生成中に失敗: {e}")
        return False

    size_kb = zipout.stat().st_size // 1024
    print(f"  → {zipout.name}  ({size_kb:,} KB, {added} ファイル)")
    return True


def build_zip_mac(root: pathlib.Path, dest: pathlib.Path) -> bool:
    missing = [d for d in ZIP_INCLUDE_DIRS if not (root / d).is_dir()]
    missing += [f for f in ZIP_INCLUDE_FILES if not (root / f).is_file()]
    if missing:
        print(f"  [エラー] 必要なファイルが見つかりません: {missing}")
        return False
    return _build_zip_platform(
        zipout=dest / "survey-tool-mac.zip",
        top_dir="survey-tool-mac",
        startup_arcname="start_mac.command",
        startup_src=root / "run.command",
    )


def build_zip_windows(root: pathlib.Path, dest: pathlib.Path) -> bool:
    missing = [d for d in ZIP_INCLUDE_DIRS if not (root / d).is_dir()]
    missing += [f for f in ZIP_INCLUDE_FILES if not (root / f).is_file()]
    if missing:
        print(f"  [エラー] 必要なファイルが見つかりません: {missing}")
        return False
    return _build_zip_platform(
        zipout=dest / "survey-tool-windows.zip",
        top_dir="survey-tool-windows",
        startup_arcname="start_windows.bat",
        startup_src=root / "run.bat",
    )


# ────────────────────────────────────────────────
# アプリ形式ビルド
# ────────────────────────────────────────────────

def build_app(root: pathlib.Path, dest: pathlib.Path) -> dict[str, bool]:
    """Electron ビルドを実行し、dmg/exe を release/ にコピーする。"""
    results: dict[str, bool] = {}

    if not shutil.which("npm"):
        print("  [エラー] npm が見つかりません。Node.js をインストールしてください。")
        print("           https://nodejs.org/")
        results["survey-tool-mac.dmg"]     = False
        results["survey-tool-windows.exe"] = False
        return results

    build_steps = [
        (["npm", "install"],                 "npm install"),
        (["npm", "run", "build"],            "npm run build（prebuild 検証）"),
        (["npx", "electron-builder", "-mw"], "electron-builder（Mac dmg + Windows exe）"),
    ]

    for cmd, label in build_steps:
        print(f"\n  実行中: {label}")
        result = subprocess.run(cmd, cwd=root)
        if result.returncode != 0:
            print(f"  [エラー] {label} に失敗しました（終了コード: {result.returncode}）")
            results["survey-tool-mac.dmg"]     = False
            results["survey-tool-windows.exe"] = False
            return results

    dest.mkdir(exist_ok=True)

    # .dmg を release/ にコピー
    dmg_src = next(
        (p for p in root.glob("dist/*.dmg") if not p.name.endswith(".blockmap")),
        None,
    )
    if dmg_src:
        dst = dest / "survey-tool-mac.dmg"
        shutil.copy2(dmg_src, dst)
        size_kb = dst.stat().st_size // 1024
        print(f"\n  → survey-tool-mac.dmg  ({size_kb:,} KB)")
        results["survey-tool-mac.dmg"] = True
    else:
        print("  [エラー] dist/*.dmg が見つかりません")
        results["survey-tool-mac.dmg"] = False

    # .exe を release/ にコピー
    exe_src = next(
        (p for p in root.glob("dist/*.exe") if not p.name.endswith(".blockmap")),
        None,
    )
    if exe_src:
        dst = dest / "survey-tool-windows.exe"
        shutil.copy2(exe_src, dst)
        size_kb = dst.stat().st_size // 1024
        print(f"  → survey-tool-windows.exe  ({size_kb:,} KB)")
        results["survey-tool-windows.exe"] = True
    else:
        print("  [エラー] dist/*.exe が見つかりません")
        results["survey-tool-windows.exe"] = False

    return results


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

    print("=" * 54)
    print("  SurveyTool 配布パッケージ生成")
    print(f"  形式: {args.format}")
    print("=" * 54)

    DEST.mkdir(exist_ok=True)

    results: dict[str, bool] = {}

    # ── ZIP 形式 ──
    if args.format in ("zip", "all"):
        print("\n--- ZIP (Mac) を生成しています ---")
        results["survey-tool-mac.zip"] = build_zip_mac(ROOT, DEST)

        print("\n--- ZIP (Windows) を生成しています ---")
        results["survey-tool-windows.zip"] = build_zip_windows(ROOT, DEST)

    # ── アプリ形式 ──
    if args.format in ("app", "all"):
        print("\n--- アプリ形式 (.dmg / .exe) を生成しています ---")
        results.update(build_app(ROOT, DEST))

    # ── release/README.txt を生成物に合わせて書き出し ──
    has_zip = results.get("survey-tool-mac.zip", False) or \
              results.get("survey-tool-windows.zip", False)
    has_app = results.get("survey-tool-mac.dmg", False) or \
              results.get("survey-tool-windows.exe", False)

    readme_path = DEST / "README.txt"
    readme_path.write_text(
        _make_release_readme(has_zip=has_zip, has_app=has_app),
        encoding="utf-8",
    )

    # ── サマリ ──
    print("\n" + "=" * 54)
    print("  生成結果サマリ")
    print("=" * 54)

    all_ok = True
    for name, ok in results.items():
        mark = "✓" if ok else "✗"
        path = DEST / name
        if ok and path.exists():
            size_kb = path.stat().st_size // 1024
            print(f"  {mark}  {name:<35}  ({size_kb:,} KB)")
            print(f"       {path}")
        else:
            print(f"  {mark}  {name}  ← 生成に失敗しました")
            all_ok = False

    print(f"\n  README.txt を更新しました: {readme_path}")
    print("=" * 54)

    if not all_ok:
        print("  一部の生成に失敗しました。上記のエラーを確認してください。")
        sys.exit(1)
    else:
        print("  すべて正常に生成されました。")


if __name__ == "__main__":
    main()

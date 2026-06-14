#!/usr/bin/env python3
"""
配布用 ZIP ビルドスクリプト。
実行: python build_release.py
出力: release/サーベイBIツール.zip
"""
import pathlib
import sys
import zipfile

ROOT   = pathlib.Path(__file__).parent
DEST   = ROOT / "release"
ZIPOUT = DEST / "サーベイBIツール.zip"

# ZIPに含めるファイル/ディレクトリ
INCLUDE = [
    "app",
    "static",
    "sample_data",
    "requirements.txt",
    "run.bat",
    "run.command",
    "README.md",
]

# 除外するディレクトリ名
EXCLUDE_DIRS = {
    "__pycache__", ".venv", ".git", ".claude",
    "tests", ".pytest_cache", "release",
}

# 除外するファイル名
EXCLUDE_FILES = {
    ".DS_Store", "build_release.py",
    "start.sh", "start.bat",
    "app.code-workspace",
}

# 除外する拡張子
EXCLUDE_EXTS = {".pyc", ".pyo", ".log", ".tmp"}


def should_exclude(path: pathlib.Path) -> bool:
    for part in path.parts:
        if part in EXCLUDE_DIRS:
            return True
    if path.name in EXCLUDE_FILES:
        return True
    if path.suffix in EXCLUDE_EXTS:
        return True
    return False


def main():
    print("=" * 50)
    print("  サーベイBIツール 配布パッケージ作成")
    print("=" * 50)

    # 含めるファイルの存在チェック
    missing = [item for item in INCLUDE if not (ROOT / item).exists()]
    if missing:
        print(f"\n[エラー] 以下のファイルが見つかりません:")
        for m in missing:
            print(f"  - {m}")
        sys.exit(1)

    DEST.mkdir(exist_ok=True)
    if ZIPOUT.exists():
        ZIPOUT.unlink()
        print(f"既存の ZIP を削除しました: {ZIPOUT.name}")

    print(f"\nZIP を作成しています: {ZIPOUT}\n")

    added = 0
    with zipfile.ZipFile(ZIPOUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in INCLUDE:
            src = ROOT / item
            if src.is_file():
                rel = pathlib.Path(item)
                if should_exclude(rel):
                    continue
                arcname = f"サーベイBIツール/{item}"
                zf.write(src, arcname)
                print(f"  追加: {arcname}")
                added += 1
            elif src.is_dir():
                for f in sorted(src.rglob("*")):
                    if not f.is_file():
                        continue
                    rel = f.relative_to(ROOT)
                    if should_exclude(rel):
                        continue
                    arcname = f"サーベイBIツール/{rel}"
                    zf.write(f, arcname)
                    print(f"  追加: {arcname}")
                    added += 1

    size_kb = ZIPOUT.stat().st_size // 1024
    print(f"\n{'=' * 50}")
    print(f"✓ 完了: {added} ファイルを追加")
    print(f"  出力: {ZIPOUT}")
    print(f"  サイズ: {size_kb:,} KB")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()

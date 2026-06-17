"""内部 Parquet キャッシュ — ユーザーには見えない高速化レイヤー。"""
from __future__ import annotations

import logging
import shutil
import tempfile
import time
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)
_BASE_DIR = Path(tempfile.gettempdir()) / "survey_parquet"


def save_parquet(session_token: str, df: pd.DataFrame, name: str = "labeled_data") -> Path:
    """DataFrame を Parquet に保存し、そのパスを返す。"""
    d = _BASE_DIR / session_token
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{name}.parquet"
    df.to_parquet(path, engine="pyarrow", index=False)
    logger.info("Parquet 保存: %s (%d rows, %d cols)", path.name, len(df), len(df.columns))
    return path


def load_parquet(path: Path, columns: list[str] | None = None) -> pd.DataFrame:
    """Parquet を読み込む。columns 指定時は列プロジェクションを適用する。"""
    if not path.exists():
        raise FileNotFoundError(f"Parquet not found: {path}")
    return pd.read_parquet(path, engine="pyarrow", columns=columns)


def cleanup_old_sessions(max_age_seconds: int = 86400) -> int:
    """起動時クリーンアップ。max_age_seconds より古いセッションディレクトリを削除する。"""
    if not _BASE_DIR.exists():
        return 0
    now = time.time()
    removed = 0
    for d in _BASE_DIR.iterdir():
        if d.is_dir() and (now - d.stat().st_mtime) > max_age_seconds:
            shutil.rmtree(d)
            logger.info("古い Parquet セッションを削除: %s", d.name)
            removed += 1
    return removed

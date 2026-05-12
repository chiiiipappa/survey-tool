"""ユーティリティ: エンコーディング検出・ファイルバリデーション。"""

from __future__ import annotations

import io
import logging
from pathlib import Path

import chardet
import pandas as pd

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".csv"}
MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  # 50MB


def detect_encoding(raw_bytes: bytes) -> str:
    """chardet でエンコーディングを推定する。信頼度 0.6 未満は UTF-8 にフォールバック。"""
    result = chardet.detect(raw_bytes)
    encoding: str = result.get("encoding") or "utf-8"
    confidence: float = result.get("confidence") or 0.0

    logger.debug(f"chardet: encoding={encoding}, confidence={confidence:.2f}")

    if confidence < 0.6:
        return "UTF-8"

    if encoding.lower() in ("shift_jis", "shift-jis", "sjis", "cp932"):
        return "Shift-JIS"

    return encoding.upper() if encoding else "UTF-8"


def decode_text(raw_bytes: bytes, encoding: str) -> str:
    """指定エンコーディングでデコード。失敗した場合は複数候補を試行する。"""
    candidates = [encoding, "utf-8", "cp932", "shift_jis_2004", "euc-jp"]
    seen: set[str] = set()
    unique_candidates = []
    for c in candidates:
        key = c.lower().replace("-", "").replace("_", "")
        if key not in seen:
            seen.add(key)
            unique_candidates.append(c)

    for enc in unique_candidates:
        try:
            return raw_bytes.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue

    logger.warning("全エンコーディング試行失敗。UTF-8 (replace) で代用します。")
    return raw_bytes.decode("utf-8", errors="replace")


def validate_file_extension(filename: str) -> bool:
    """ファイル拡張子が許可リストに含まれるか確認する。"""
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def validate_file_size(size_bytes: int) -> bool:
    """ファイルサイズが制限内か確認する。"""
    return size_bytes <= MAX_FILE_SIZE_BYTES


def load_csv_to_df(raw_bytes: bytes, encoding: str) -> pd.DataFrame:
    """CSV ファイルを DataFrame として読み込む。BOM を除去してから処理する。"""
    text = decode_text(raw_bytes, encoding)
    # UTF-8 BOM を除去
    text = text.lstrip("﻿")
    df = pd.read_csv(io.StringIO(text), header=0, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    return df

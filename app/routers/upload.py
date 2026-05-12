"""アップロードルーター: レイアウト CSV の受け取りとパース。"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.data_store import survey_cache
from app.parser.layout_csv import parse_layout_csv
from app.schemas import UploadResponse
from app.utils import detect_encoding, validate_file_extension, validate_file_size

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/upload", response_model=UploadResponse, summary="レイアウト CSV アップロード")
async def upload_file(file: UploadFile = File(...)) -> UploadResponse:
    """
    レイアウト CSV をアップロードし、設問構造に変換して返す。
    元データはメモリ内にキャッシュし、外部には送信しない。
    """
    raw = await file.read()
    filename = file.filename or "unknown"

    if not validate_file_extension(filename):
        raise HTTPException(
            status_code=422,
            detail=f"CSV ファイルのみ対応しています。（受け取ったファイル: {filename}）",
        )
    if not validate_file_size(len(raw)):
        mb = len(raw) / 1024 / 1024
        raise HTTPException(
            status_code=413,
            detail=f"ファイルサイズが上限（50MB）を超えています。（{mb:.1f}MB）",
        )

    encoding = detect_encoding(raw)

    try:
        questions, parse_warnings, choice_col_mode, unknown_types = parse_layout_csv(
            raw, encoding
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"パースエラー: {e}", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail=f"CSV の解析中にエラーが発生しました: {e}",
        )

    all_type_codes = sorted(set(q.type_code for q in questions if q.type_code))
    column_names: list[str] = []
    # 列名は再取得不要 — parse_layout_csv が処理済み行を返す
    # UploadResponse 用に meta 情報をまとめる
    token = str(uuid.uuid4())
    meta = {
        "filename": filename,
        "encoding": encoding,
        "file_size": len(raw),
        "raw": raw,
        "column_names": column_names,
        "choice_column_mode": choice_col_mode,
        "parse_warnings": parse_warnings,
        "unknown_types": unknown_types,
        "all_type_codes": all_type_codes,
    }
    survey_cache.set(token, questions, meta)

    logger.info(
        f"アップロード完了: {filename} ({len(questions)}設問, "
        f"encoding={encoding}, mode={choice_col_mode}) token={token[:8]}..."
    )

    return UploadResponse(
        session_token=token,
        filename=filename,
        file_size=len(raw),
        encoding_detected=encoding,
        row_count=len(questions),
        column_names=column_names,
        choice_column_mode=choice_col_mode,
        questions=questions,
        parse_warnings=parse_warnings,
        unknown_types=unknown_types,
    )

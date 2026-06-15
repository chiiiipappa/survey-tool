"""アップロードルーター: レイアウト CSV の受け取りとパース。"""

from __future__ import annotations

import asyncio
import logging
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.data_store import survey_cache
from app.parser.layout_csv import (
    NeedsManualMappingError,
    parse_layout_csv,
    parse_layout_excel,
    parse_with_manual_mapping,
)
from app.schemas import RemapRequest, UploadResponse
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
            detail=f"CSV (.csv) または Excel (.xlsx) ファイルを選択してください。（受け取ったファイル: {filename}）",
        )
    if not validate_file_size(len(raw)):
        mb = len(raw) / 1024 / 1024
        raise HTTPException(
            status_code=413,
            detail=f"ファイルサイズが上限（50MB）を超えています。（{mb:.1f}MB）",
        )

    is_excel = filename.lower().endswith(".xlsx")
    encoding = "Excel" if is_excel else detect_encoding(raw)

    try:
        if is_excel:
            questions, parse_warnings, choice_col_mode, unknown_types, detected_fmt, fmt_info = (
                await asyncio.to_thread(parse_layout_excel, raw)
            )
        else:
            questions, parse_warnings, choice_col_mode, unknown_types, detected_fmt, fmt_info = (
                await asyncio.to_thread(parse_layout_csv, raw, encoding)
            )
    except NeedsManualMappingError as e:
        token = str(uuid.uuid4())
        meta = {
            "filename": filename,
            "encoding": encoding,
            "file_size": len(raw),
            "raw": raw,
        }
        survey_cache.set(token, [], meta)
        logger.info(f"手動マッピング必要: {filename}, 列数={len(e.columns)}, token={token[:8]}...")
        return UploadResponse(
            session_token=token,
            filename=filename,
            file_size=len(raw),
            encoding_detected=encoding,
            needs_manual_mapping=True,
            available_columns=e.columns,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"パースエラー: {e}", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail=f"ファイルの解析中にエラーが発生しました: {e}",
        )

    all_type_codes = sorted(set(q.type_code for q in questions if q.type_code))
    token = str(uuid.uuid4())
    meta = {
        "filename": filename,
        "encoding": encoding,
        "file_size": len(raw),
        "raw": raw,
        "choice_column_mode": choice_col_mode,
        "parse_warnings": parse_warnings,
        "unknown_types": unknown_types,
        "all_type_codes": all_type_codes,
    }
    survey_cache.set(token, questions, meta)

    logger.info(
        f"アップロード完了: {filename} ({len(questions)}設問, "
        f"encoding={encoding}, mode={choice_col_mode}, fmt={detected_fmt}) token={token[:8]}..."
    )

    return UploadResponse(
        session_token=token,
        filename=filename,
        file_size=len(raw),
        encoding_detected=encoding,
        row_count=len(questions),
        choice_column_mode=choice_col_mode,
        questions=questions,
        parse_warnings=parse_warnings,
        unknown_types=unknown_types,
        detected_format=detected_fmt,
        format_info=fmt_info,
    )


@router.post("/upload/remap", response_model=UploadResponse, summary="手動マッピングで再パース")
async def remap_upload(req: RemapRequest) -> UploadResponse:
    """
    キャッシュ済み raw バイト列に対してユーザー指定の列マッピングを適用して再パースする。
    """
    meta = survey_cache.get_meta(req.session_token)
    if meta is None:
        raise HTTPException(status_code=404, detail="セッションが見つかりません。再度ファイルを選択してください。")
    raw = meta.get("raw")
    if not raw:
        raise HTTPException(status_code=404, detail="キャッシュされたファイルが見つかりません。再度アップロードしてください。")

    encoding = meta.get("encoding", "utf-8")
    filename = meta.get("filename", "unknown")

    try:
        questions, parse_warnings, choice_col_mode, unknown_types, detected_fmt, fmt_info = (
            await asyncio.to_thread(parse_with_manual_mapping, raw, encoding, req.col_mapping)
        )
    except Exception as e:
        logger.error(f"手動マッピングパースエラー: {e}", exc_info=True)
        raise HTTPException(status_code=422, detail=f"マッピングの適用に失敗しました: {e}")

    all_type_codes = sorted(set(q.type_code for q in questions if q.type_code))
    updated_meta = {
        **meta,
        "choice_column_mode": choice_col_mode,
        "parse_warnings": parse_warnings,
        "unknown_types": unknown_types,
        "all_type_codes": all_type_codes,
    }
    survey_cache.set(req.session_token, questions, updated_meta)

    logger.info(
        f"手動マッピング完了: {filename} ({len(questions)}設問) token={req.session_token[:8]}..."
    )

    return UploadResponse(
        session_token=req.session_token,
        filename=filename,
        file_size=meta.get("file_size", 0),
        encoding_detected=encoding,
        row_count=len(questions),
        choice_column_mode=choice_col_mode,
        questions=questions,
        parse_warnings=parse_warnings,
        unknown_types=unknown_types,
        detected_format=detected_fmt,
        format_info=fmt_info,
    )

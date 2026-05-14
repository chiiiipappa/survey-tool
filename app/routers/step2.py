"""STEP2: 回答データ読込・ラベル変換 エンドポイント。"""

from __future__ import annotations

import io
import logging
from datetime import datetime

import pandas as pd
from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.data_store import survey_cache
from app.parser.response_csv import (
    build_axis_candidates,
    build_codebook,
    build_fa_data,
    build_fa_meta,
    classify_missing_columns,
    convert_labels,
    detect_multi_select,
    df_preview,
    df_to_serializable,
    match_columns,
    parse_response_file,
)
from app.schemas import (
    AxisCandidateItem,
    BracketColumnItem,
    FaAttrCandidate,
    FaColumnInfo,
    FaRow,
    MissingColumnDetail,
    Step2AxisSaveRequest,
    Step2FaMetaResponse,
    Step2FaResponse,
    Step2StateResponse,
    Step2UploadResponse,
    UnmatchedValueItem,
)

logger = logging.getLogger(__name__)
router = APIRouter()

ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls"}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB


@router.post("/step2/upload", response_model=Step2UploadResponse, summary="回答データアップロード・ラベル変換")
async def step2_upload(
    session_token: str = Form(...),
    file: UploadFile = ...,
) -> Step2UploadResponse:
    """
    回答 CSV / xlsx をアップロードし、STEP1 のレイアウト情報でラベル変換する。

    - raw_data と labeled_data を分離して保持する
    - 変換辞書は Question 単位で作成する
    """
    filename = file.filename or ""
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, f"対応していないファイル形式です: {filename}（.csv / .xlsx のみ）")

    raw_bytes = await file.read()
    if len(raw_bytes) > MAX_FILE_SIZE:
        raise HTTPException(413, "ファイルサイズが上限（50MB）を超えています。")

    questions = survey_cache.get_questions(session_token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。STEP1 からやり直してください。")

    try:
        df, encoding = parse_response_file(raw_bytes, filename)
    except Exception as exc:
        logger.exception("回答データ解析エラー")
        raise HTTPException(422, f"ファイルの読み込みに失敗しました: {exc}") from exc

    layout_codes = [q.question_code for q in questions]
    codebook = build_codebook(questions)
    matched, missing, extra, bracket_cols_raw = match_columns(list(df.columns), layout_codes, questions)
    bracket_columns = [BracketColumnItem(**bc) for bc in bracket_cols_raw]
    missing_details_raw = classify_missing_columns(missing, questions, matched, bracket_cols_raw)
    missing_details = [MissingColumnDetail(**d) for d in missing_details_raw]
    labeled_df, unmatched_values = convert_labels(df, codebook, matched, bracket_cols_raw)
    multi_select_cols = detect_multi_select(df, questions, matched)
    axis_candidates = build_axis_candidates(questions, matched)

    raw_data = df_to_serializable(df)
    labeled_data = df_to_serializable(labeled_df)

    survey_cache.set_step2(
        session_token,
        {
            "filename": filename,
            "encoding": encoding,
            "file_size": len(raw_bytes),
            "raw_data": raw_data,
            "labeled_data": labeled_data,
            "codebook": codebook,
            "matched_columns": matched,
            "missing_columns": missing,
            "extra_columns": extra,
            "bracket_columns": [bc.model_dump() for bc in bracket_columns],
            "missing_column_details": [d.model_dump() for d in missing_details],
            "unmatched_values": unmatched_values,
            "response_row_count": len(df),
            "response_col_count": len(df.columns),
            "axis_candidates": [c.model_dump() for c in axis_candidates],
            "selected_axis_columns": [c.question_code for c in axis_candidates if c.is_default_selected],
            "selected_axis_labels": {},
            "axis_display_order": [],
            "axis_filter_settings": {},
            "multi_select_columns": multi_select_cols,
        },
    )

    logger.info(
        "STEP2 アップロード完了: file=%s, rows=%d, matched=%d, missing=%d, extra=%d",
        filename, len(df), len(matched), len(missing), len(extra),
    )

    return Step2UploadResponse(
        filename=filename,
        file_size=len(raw_bytes),
        encoding_detected=encoding,
        response_row_count=len(df),
        response_col_count=len(df.columns),
        preview_rows=df_preview(df),
        labeled_preview_rows=df_preview(labeled_df),
        matched_columns=matched,
        missing_columns=missing,
        extra_columns=extra,
        matched_question_count=len(matched),
        unmatched_question_count=len(missing),
        codebook=codebook,
        unmatched_values=[UnmatchedValueItem(**u) for u in unmatched_values],
        axis_candidates=axis_candidates,
        multi_select_columns=multi_select_cols,
        bracket_columns=bracket_columns,
        missing_column_details=missing_details,
    )


@router.get("/step2/state", response_model=Step2StateResponse, summary="STEP2 状態取得")
async def step2_state(session_token: str) -> Step2StateResponse:
    """現在の STEP2 状態を返す（回答データ未アップロードの場合は has_data=False）。"""
    data = survey_cache.get_step2(session_token)
    if not data:
        return Step2StateResponse(has_data=False)

    return Step2StateResponse(
        has_data=True,
        filename=data.get("filename"),
        response_row_count=data.get("response_row_count", 0),
        matched_columns=data.get("matched_columns", []),
        missing_columns=data.get("missing_columns", []),
        extra_columns=data.get("extra_columns", []),
        selected_axis_columns=data.get("selected_axis_columns", []),
        axis_candidates=[AxisCandidateItem(**c) for c in data.get("axis_candidates", [])],
        multi_select_columns=data.get("multi_select_columns", []),
        bracket_columns=[BracketColumnItem(**bc) for bc in data.get("bracket_columns", [])],
        missing_column_details=[MissingColumnDetail(**d) for d in data.get("missing_column_details", [])],
    )


@router.post("/step2/axis", summary="集計軸選択を保存")
async def step2_save_axis(body: Step2AxisSaveRequest) -> dict:
    """選択された集計軸列を保存する。"""
    data = survey_cache.get_step2(body.session_token)
    if not data:
        raise HTTPException(404, "STEP2 データが見つかりません。先に回答データをアップロードしてください。")

    data["selected_axis_columns"] = body.selected_axis_columns
    survey_cache.set_step2(body.session_token, data)

    logger.info("集計軸保存: %s", body.selected_axis_columns)
    return {"status": "ok", "selected_axis_columns": body.selected_axis_columns}


@router.get("/step2/export", summary="ラベル変換済みデータを CSV エクスポート")
async def step2_export(session_token: str) -> StreamingResponse:
    """ラベル変換済みデータを UTF-8 BOM 付き CSV としてダウンロードする。"""
    data = survey_cache.get_step2(session_token)
    if not data:
        raise HTTPException(404, "STEP2 データが見つかりません。")

    labeled_data = data.get("labeled_data", {})
    if not labeled_data:
        raise HTTPException(422, "ラベル変換済みデータがありません。")

    df = pd.DataFrame(labeled_data)
    buffer = io.StringIO()
    df.to_csv(buffer, index=False, encoding="utf-8-sig")
    content = buffer.getvalue()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dl_filename = f"labeled_data_{timestamp}.csv"

    return StreamingResponse(
        iter([content.encode("utf-8-sig")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{dl_filename}"'},
    )


@router.get("/step2/fa/meta", response_model=Step2FaMetaResponse, summary="FA閲覧メタ情報取得（行データなし）")
async def step2_fa_meta(session_token: str) -> Step2FaMetaResponse:
    """FA設問リスト・属性列候補のみ返す。UI初期化用（行データは生成しない）。"""
    questions = survey_cache.get_questions(session_token)
    data = survey_cache.get_step2(session_token)

    if questions is None or not data:
        raise HTTPException(404, "セッションが見つかりません。STEP1・STEP2 からやり直してください。")

    axis_candidates = [AxisCandidateItem(**c) for c in data.get("axis_candidates", [])]
    selected_axis = data.get("selected_axis_columns", [])

    result = build_fa_meta(
        questions=questions,
        labeled_data=data.get("labeled_data", {}),
        matched_columns=data.get("matched_columns", []),
        axis_candidates=axis_candidates,
        selected_axis_columns=selected_axis,
    )

    return Step2FaMetaResponse(
        fa_columns=[FaColumnInfo(**c) for c in result["fa_columns"]],
        attr_candidates=[FaAttrCandidate(**c) for c in result["attr_candidates"]],
        key_column_name=result["key_column_name"],
    )


@router.get("/step2/fa", response_model=Step2FaResponse, summary="自由回答（FA）閲覧データ取得")
async def step2_fa(
    session_token: str,
    attr_columns: str = "",
    fa_codes: str = "",
    exclude_empty: bool = True,
    min_chars: int = 0,
    sort_by: str = "response_order",
    sort_attr: str = "",
    keyword: str = "",
) -> Step2FaResponse:
    """FA列のデータを縦持ちで返す。フィルタ・ソートはサーバー側で処理する。"""
    questions = survey_cache.get_questions(session_token)
    data = survey_cache.get_step2(session_token)

    if questions is None or not data:
        raise HTTPException(404, "セッションが見つかりません。STEP1・STEP2 からやり直してください。")

    attr_col_list = [c for c in attr_columns.split(",") if c] if attr_columns else []
    fa_code_list = [c for c in fa_codes.split(",") if c] if fa_codes else []
    axis_candidates = [AxisCandidateItem(**c) for c in data.get("axis_candidates", [])]
    selected_axis = data.get("selected_axis_columns", [])

    result = build_fa_data(
        questions=questions,
        labeled_data=data.get("labeled_data", {}),
        matched_columns=data.get("matched_columns", []),
        axis_candidates=axis_candidates,
        selected_axis_columns=selected_axis,
        attr_columns=attr_col_list,
        exclude_empty=exclude_empty,
        min_chars=min_chars,
        sort_by=sort_by,
        sort_attr=sort_attr,
        fa_codes=fa_code_list,
        keyword=keyword,
    )

    return Step2FaResponse(
        fa_columns=[FaColumnInfo(**c) for c in result["fa_columns"]],
        attr_candidates=[FaAttrCandidate(**c) for c in result["attr_candidates"]],
        key_column_name=result["key_column_name"],
        total_fa_rows=result["total_fa_rows"],
        filtered_row_count=result["filtered_row_count"],
        empty_row_count=result.get("empty_row_count", 0),
        rows=[FaRow(**r) for r in result["rows"]],
    )


@router.get("/step2/fa/export", summary="自由回答（FA）データをエクスポート")
async def step2_fa_export(
    session_token: str,
    attr_columns: str = "",
    fa_codes: str = "",
    exclude_empty: bool = True,
    min_chars: int = 0,
    sort_by: str = "response_order",
    sort_attr: str = "",
    keyword: str = "",
    format: str = "csv",
) -> StreamingResponse:
    """FA閲覧データを CSV または Excel としてダウンロードする。"""
    questions = survey_cache.get_questions(session_token)
    data = survey_cache.get_step2(session_token)

    if questions is None or not data:
        raise HTTPException(404, "セッションが見つかりません。")

    attr_col_list = [c for c in attr_columns.split(",") if c] if attr_columns else []
    fa_code_list = [c for c in fa_codes.split(",") if c] if fa_codes else []
    axis_candidates = [AxisCandidateItem(**c) for c in data.get("axis_candidates", [])]
    selected_axis = data.get("selected_axis_columns", [])

    result = build_fa_data(
        questions=questions,
        labeled_data=data.get("labeled_data", {}),
        matched_columns=data.get("matched_columns", []),
        axis_candidates=axis_candidates,
        selected_axis_columns=selected_axis,
        attr_columns=attr_col_list,
        exclude_empty=exclude_empty,
        min_chars=min_chars,
        sort_by=sort_by,
        sort_attr=sort_attr,
        fa_codes=fa_code_list,
        keyword=keyword,
    )

    key_column_name = result["key_column_name"]
    rows = result["rows"]

    # DataFrame 化（縦持ち）
    records = []
    for r in rows:
        if exclude_empty and r.get("is_empty"):
            continue
        rec: dict = {}
        if key_column_name and r["key_value"]:
            rec["回答ID"] = r["key_value"]
        rec["RowID"] = r["row_index"] + 1
        rec.update(r["attr_values"])
        rec["設問コード"] = r["question_code"]
        rec["質問文"] = r["question_text"]
        rec["回答本文"] = r["answer"]
        rec["文字数"] = r["char_count"]
        records.append(rec)

    export_df = pd.DataFrame(records)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    if format == "excel":
        buffer = io.BytesIO()
        with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
            export_df.to_excel(writer, index=False, sheet_name="FA回答")
        buffer.seek(0)
        dl_filename = f"fa_export_{timestamp}.xlsx"
        return StreamingResponse(
            iter([buffer.read()]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{dl_filename}"'},
        )

    buffer_str = io.StringIO()
    export_df.to_csv(buffer_str, index=False, encoding="utf-8-sig")
    content = buffer_str.getvalue()
    dl_filename = f"fa_export_{timestamp}.csv"
    return StreamingResponse(
        iter([content.encode("utf-8-sig")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{dl_filename}"'},
    )

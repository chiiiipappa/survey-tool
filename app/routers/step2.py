"""STEP2: 回答データ読込・ラベル変換 エンドポイント。"""

from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.data_store import survey_cache
from app.parquet_cache import load_parquet, save_parquet
from app.parser.response_csv import (
    apply_label_fixes,
    apply_manual_matches,
    build_axis_candidates,
    build_codebook,
    build_fa_data,
    build_fa_meta,
    build_questant_codebook,
    classify_missing_columns,
    convert_labels,
    detect_multi_select,
    df_preview,
    match_columns,
    parse_response_file,
)
from app.schemas import (
    AxisCandidateItem,
    BracketColumnItem,
    FaAttrCandidate,
    FaColumnInfo,
    FaRow,
    LabelFixRequest,
    LabelFixResponse,
    ManualMatchRequest,
    ManualMatchResponse,
    MissingColumnDetail,
    Step2AxisSaveRequest,
    Step2FaMetaResponse,
    Step2FaResponse,
    Step2FaSettingsRequest,
    Step2StateResponse,
    Step2UploadResponse,
    UnmatchedValueItem,
)

logger = logging.getLogger(__name__)
router = APIRouter()

ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls"}
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB

# セッションごとのアップロード進捗（スレッド安全: GIL + dict 代入はアトミック）
_upload_progress: dict[str, dict] = {}


def _set_progress(token: str, pct: int, message: str) -> None:
    _upload_progress[token] = {"pct": pct, "message": message, "done": False}


@router.get("/step2/progress/{session_token}", summary="STEP2 アップロード進捗取得")
async def get_step2_progress(session_token: str):
    return _upload_progress.get(session_token, {"pct": 0, "message": "待機中…", "done": False})


@router.post("/step2/upload", response_model=Step2UploadResponse, summary="回答データアップロード・ラベル変換")
async def step2_upload(
    session_token: str = Form(...),
    file: UploadFile = ...,
    response_format: str = Form("auto"),
) -> Step2UploadResponse:
    """
    回答 CSV / xlsx をアップロードし、STEP1 のレイアウト情報でラベル変換する。

    - raw_data と labeled_data を分離して保持する
    - 変換辞書は Question 単位で作成する
    - 回答データ形式は STEP1 で確定した survey_format をサーバ側で参照する
      （クライアントから送られる response_format は使用しない）
    """
    filename = file.filename or ""
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, f"対応していないファイル形式です: {filename}（.csv / .xlsx のみ）")

    raw_bytes = await file.read()
    if len(raw_bytes) > MAX_FILE_SIZE:
        raise HTTPException(413, "ファイルサイズが上限（500MB）を超えています。")

    questions = survey_cache.get_questions(session_token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。STEP1 からやり直してください。")

    meta = survey_cache.get_meta(session_token) or {}
    survey_format = meta.get("survey_format", "unknown")
    if survey_format not in ("intage", "questant"):
        raise HTTPException(400, "先に調査票レイアウトを読み込み、形式を確定してください。")
    response_format = survey_format

    # 既存の手動ラベル修正を保持（差し替え時の自動再適用）
    _existing_step2 = survey_cache.get_step2(session_token)
    _pre_existing_fixes: list[dict] = (_existing_step2 or {}).get("manual_label_fixes", [])

    # 重い同期処理をスレッドプールで実行（イベントループをブロックしない）
    def _process():
        _set_progress(session_token, 10, "ファイル解析中…")
        df_, enc = parse_response_file(raw_bytes, filename)
        layout_codes_ = [q.question_code for q in questions]

        _set_progress(session_token, 30, "変換辞書を構築中…")
        if response_format == "questant":
            codebook_ = build_questant_codebook(questions)
        else:
            codebook_ = build_codebook(questions)
        matched_, missing_, extra_, bracket_cols_raw_ = match_columns(
            list(df_.columns), layout_codes_, questions, format_hint=response_format
        )
        missing_details_raw_ = classify_missing_columns(
            missing_, questions, matched_, bracket_cols_raw_
        )

        _set_progress(session_token, 55, "ラベル変換中…")
        labeled_df_, unmatched_ = convert_labels(df_, codebook_, matched_, bracket_cols_raw_)

        # 既存の手動修正を再適用
        manual_fixes_result_: list[dict] = []
        if _pre_existing_fixes:
            labeled_df_, unmatched_, manual_fixes_result_, _ = apply_label_fixes(
                df_, labeled_df_, _pre_existing_fixes, unmatched_, []
            )

        _set_progress(session_token, 75, "MA展開・集計軸検出中…")
        multi_select_ = detect_multi_select(df_, questions, matched_)
        axis_candidates_ = build_axis_candidates(questions, matched_)

        _set_progress(session_token, 90, "Parquet保存中…")
        rp_ = save_parquet(session_token, df_, "raw_data")
        lp_ = save_parquet(session_token, labeled_df_, "labeled_data")

        _upload_progress[session_token] = {"pct": 100, "message": "完了", "done": True}
        return (df_, enc, labeled_df_, unmatched_,
                matched_, missing_, extra_,
                bracket_cols_raw_, missing_details_raw_,
                multi_select_, axis_candidates_, rp_, lp_, codebook_,
                manual_fixes_result_)

    try:
        (df, encoding, labeled_df, unmatched_values,
         matched, missing, extra,
         bracket_cols_raw, missing_details_raw,
         multi_select_cols, axis_candidates, raw_parquet_path, labeled_parquet_path, codebook,
         manual_label_fixes,
         ) = await asyncio.to_thread(_process)
    except Exception as exc:
        _upload_progress.pop(session_token, None)
        logger.exception("回答データ解析エラー")
        raise HTTPException(422, f"ファイルの読み込みに失敗しました: {exc}") from exc
    finally:
        # 完了・エラー後は30秒で自動削除（ポーリングが拾えるよう少し残す）
        async def _cleanup():
            await asyncio.sleep(30)
            _upload_progress.pop(session_token, None)
        asyncio.ensure_future(_cleanup())

    bracket_columns = [BracketColumnItem(**bc) for bc in bracket_cols_raw]
    missing_details = [MissingColumnDetail(**d) for d in missing_details_raw]

    all_response_cols = list(df.columns)

    survey_cache.set_step2(
        session_token,
        {
            "filename": filename,
            "encoding": encoding,
            "file_size": len(raw_bytes),
            "raw_parquet_path": str(raw_parquet_path),
            "labeled_parquet_path": str(labeled_parquet_path),
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
            "manual_match_rules": [],
            "manual_label_fixes": manual_label_fixes,
            "all_response_columns": all_response_cols,
            "response_format": response_format,
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
        all_response_columns=all_response_cols,
    )


@router.post("/step2/manual-match", response_model=ManualMatchResponse, summary="手動照合ルールを適用")
async def step2_manual_match(body: ManualMatchRequest) -> ManualMatchResponse:
    """
    手動照合ルールを受け取り、該当する回答データ列にレイアウトコードのコードブックを適用する。
    更新後の labeled_data を Parquet に保存し、照合結果詳細を返す。
    """
    data = survey_cache.get_step2(body.session_token)
    if not data:
        raise HTTPException(404, "STEP2 データが見つかりません。先に回答データをアップロードしてください。")

    raw_path = data.get("raw_parquet_path")
    labeled_path = data.get("labeled_parquet_path")
    if not raw_path or not labeled_path:
        raise HTTPException(422, "データが見つかりません。回答データを再アップロードしてください。")

    try:
        raw_df = load_parquet(Path(raw_path))
        labeled_df = load_parquet(Path(labeled_path))
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。回答データを再アップロードしてください。")

    rules = [r.model_dump() for r in body.rules]
    codebook = data.get("codebook", {})
    existing_details = data.get("missing_column_details", [])

    def _apply():
        return apply_manual_matches(raw_df, labeled_df, codebook, rules, existing_details)

    try:
        updated_labeled_df, updated_details, new_unmatched = await asyncio.to_thread(_apply)
    except Exception as exc:
        logger.exception("手動照合エラー")
        raise HTTPException(422, f"手動照合の適用に失敗しました: {exc}") from exc

    new_lp = save_parquet(body.session_token, updated_labeled_df, "labeled_data")

    # 手動照合済みの回答データ列を extra_columns から除外
    manually_used_cols: set[str] = set()
    for rule in rules:
        manually_used_cols.update(rule.get("response_cols", []))
    existing_extra = data.get("extra_columns", [])
    new_extra = [c for c in existing_extra if c not in manually_used_cols]

    data["missing_column_details"] = updated_details
    data["labeled_parquet_path"] = str(new_lp)
    data["manual_match_rules"] = rules
    data["extra_columns"] = new_extra
    survey_cache.set_step2(body.session_token, data)

    warnings: list[str] = []
    all_response_cols = set(raw_df.columns)
    for rule in rules:
        for col in rule.get("response_cols", []):
            if col not in all_response_cols:
                warnings.append(f"列 '{col}' は回答データに存在しません。")

    logger.info("手動照合適用: %d ルール, warnings=%d", len(rules), len(warnings))

    return ManualMatchResponse(
        matched_columns=data.get("matched_columns", []),
        extra_columns=new_extra,
        missing_column_details=[MissingColumnDetail(**d) for d in updated_details],
        labeled_preview_rows=df_preview(updated_labeled_df),
        unmatched_values=[UnmatchedValueItem(**u) for u in new_unmatched],
        manual_match_rules=rules,
        warnings=warnings,
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

    parquet_path = data.get("labeled_parquet_path")
    if not parquet_path:
        raise HTTPException(422, "ラベル変換済みデータがありません。")
    try:
        df = load_parquet(Path(parquet_path))
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。再アップロードしてください。")
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
        labeled_parquet_path=data.get("labeled_parquet_path"),
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
        labeled_parquet_path=data.get("labeled_parquet_path"),
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
        labeled_parquet_path=data.get("labeled_parquet_path"),
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


@router.post("/step2/label-fix", response_model=LabelFixResponse, summary="変換不可値の手動ラベル修正を適用")
async def step2_label_fix(body: LabelFixRequest) -> LabelFixResponse:
    """
    指定された変換不可値に手動ラベルを割り当て、labeled_df を更新する。
    修正済みの値は変換不可値リストから除外される。
    """
    data = survey_cache.get_step2(body.session_token)
    if not data:
        raise HTTPException(404, "STEP2 データが見つかりません。先に回答データをアップロードしてください。")

    raw_path = data.get("raw_parquet_path")
    labeled_path = data.get("labeled_parquet_path")
    if not raw_path or not labeled_path:
        raise HTTPException(422, "データが見つかりません。回答データを再アップロードしてください。")

    try:
        raw_df = load_parquet(Path(raw_path))
        labeled_df = load_parquet(Path(labeled_path))
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。回答データを再アップロードしてください。")

    fixes = [f.model_dump() for f in body.fixes]
    existing_unmatched = data.get("unmatched_values", [])
    existing_manual_fixes = data.get("manual_label_fixes", [])

    def _apply():
        return apply_label_fixes(raw_df, labeled_df, fixes, existing_unmatched, existing_manual_fixes)

    try:
        updated_labeled_df, remaining_unmatched, merged_fixes, resolved_count = await asyncio.to_thread(_apply)
    except Exception as exc:
        logger.exception("ラベル修正エラー")
        raise HTTPException(422, f"ラベル修正の適用に失敗しました: {exc}") from exc

    new_lp = save_parquet(body.session_token, updated_labeled_df, "labeled_data")

    data["labeled_parquet_path"] = str(new_lp)
    data["unmatched_values"] = remaining_unmatched
    data["manual_label_fixes"] = merged_fixes
    survey_cache.set_step2(body.session_token, data)

    logger.info("ラベル修正適用: %d 件修正, 残り %d 件", resolved_count, len(remaining_unmatched))

    return LabelFixResponse(
        applied_count=resolved_count,
        remaining_unmatched=[UnmatchedValueItem(**u) for u in remaining_unmatched],
        labeled_preview_rows=df_preview(updated_labeled_df),
    )


@router.post("/step2/fa/settings", summary="FA設定を保存")
async def step2_save_fa_settings(body: Step2FaSettingsRequest) -> dict:
    """選択中の FA 設問コードと付与属性列をセッションキャッシュに保存する。"""
    data = survey_cache.get_step2(body.session_token)
    if not data:
        raise HTTPException(404, "STEP2 データが見つかりません。先に回答データをアップロードしてください。")
    data["selected_fa_codes"] = body.selected_fa_codes
    data["selected_attr_columns"] = body.selected_attr_columns
    survey_cache.set_step2(body.session_token, data)
    return {"status": "ok"}

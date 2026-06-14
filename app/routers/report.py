"""レポート生成エンドポイント。"""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.data_store import survey_cache
from app.parquet_cache import load_parquet
from app.routers.step3 import _build_axis_cats, _crosstab_ma, _crosstab_sa
from app.schemas import (
    ReportComparisonDataset,
    ReportGenerateRequest,
    ReportGenerateResponse,
    ReportPageData,
    ReportRow,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_CROSSTAB_SA_TYPES = {"SA", "S", "NU", "N", "SL"}
_CROSSTAB_MA_TYPES = {"MA", "ML", "M"}
_SKIP_TYPES = {"FA", "OA", "OE", "FT", "FN", "XL", "F"}


def _short_label(q) -> str:
    """設問の短いラベルを返す（stub → 質問文20字 の順で優先）。"""
    if q.stub and q.stub.strip():
        return q.stub.strip()
    text = q.question_text.strip()
    return text[:20] + ("…" if len(text) > 20 else "")


def _safe_float(val: float) -> float:
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return round(val, 1)


def _crosstab_total(
    df: pd.DataFrame,
    q_code: str,
    type_code: str,
    bracket_cols: list[dict],
) -> tuple[list[ReportRow], int]:
    """軸なし全体集計。(rows, total_n) を返す。"""
    tc = type_code.upper()
    n = len(df)
    rows: list[ReportRow] = []

    if tc in _CROSSTAB_SA_TYPES:
        if q_code not in df.columns:
            return [], n
        vc = df[q_code].value_counts()
        for label, cnt in vc.items():
            pct = _safe_float(cnt / n * 100) if n > 0 else 0.0
            rows.append(ReportRow(label=str(label), percents=[pct], counts=[int(cnt)]))

    elif tc in _CROSSTAB_MA_TYPES:
        for bc in bracket_cols:
            dcol = bc["display_header"]
            if dcol not in df.columns:
                continue
            val_str = df[dcol].fillna("").astype(str).str.strip()
            cnt = int((~val_str.isin(["", "-"])).sum())
            pct = _safe_float(cnt / n * 100) if n > 0 else 0.0
            rows.append(ReportRow(label=bc["choice_label"], percents=[pct], counts=[cnt]))

    return rows, n


def _make_page_id(mode: str, q_code: str, axis_code: str) -> str:
    return f"{mode}|{q_code}|{axis_code or 'total'}"


_MA_TARGET_TYPES = {"MA", "M", "ML"}


def _is_ma_target(target_column: str, q_map: dict) -> bool:
    q = q_map.get(target_column)
    return q is not None and q.type_code.upper() in _MA_TARGET_TYPES


def _filter_by_ma_choice(
    df: pd.DataFrame,
    target_column: str,
    target_value: str,
    bracket_by_base: dict,
) -> "pd.DataFrame | None":
    bcs = bracket_by_base.get(target_column, [])
    bc = next((b for b in bcs if b["choice_label"] == target_value), None)
    if bc is None:
        return None
    col = bc["display_header"]
    if col not in df.columns:
        return None
    vals = df[col].fillna("").astype(str).str.strip()
    return df[~vals.isin(["", "-"])]


def _ma_axis_total(
    df: pd.DataFrame,
    target_column: str,
    target_value: str,
    bracket_by_base: dict,
) -> int:
    filt = _filter_by_ma_choice(df, target_column, target_value, bracket_by_base)
    return len(filt) if filt is not None else 0


def _crosstab_with_ma_axis(
    df: pd.DataFrame,
    q_code: str,
    tc: str,
    bracket_cols_for_q: list[dict],
    target_column: str,
    target_values: list[str],
    bracket_by_base: dict,
) -> list:
    """MA 選択肢ごとにフィルタして設問をクロス集計。_crosstab_sa と同じ形式のオブジェクトリストを返す。"""
    all_labels: list[str] = []
    per_tv: list[tuple] = []

    for tv in target_values:
        df_filt = _filter_by_ma_choice(df, target_column, tv, bracket_by_base)
        if df_filt is None or df_filt.empty:
            per_tv.append((None, 0))
            continue
        n = len(df_filt)
        per_tv.append((df_filt, n))
        if not all_labels:
            if tc in _CROSSTAB_SA_TYPES and q_code in df_filt.columns:
                all_labels = [str(v) for v in df_filt[q_code].dropna().unique()]
            elif tc in _CROSSTAB_MA_TYPES:
                all_labels = [b["choice_label"] for b in bracket_cols_for_q]

    class _Row:
        __slots__ = ("label", "percents", "counts")
        def __init__(self, label, percents, counts):
            self.label, self.percents, self.counts = label, percents, counts

    rows = []
    for label in all_labels:
        percents: list[float] = []
        counts: list[int] = []
        for df_filt, n in per_tv:
            if df_filt is None or n == 0:
                percents.append(0.0)
                counts.append(0)
                continue
            if tc in _CROSSTAB_SA_TYPES:
                cnt = int((df_filt[q_code] == label).sum()) if q_code in df_filt.columns else 0
            else:
                bc = next((b for b in bracket_cols_for_q if b["choice_label"] == label), None)
                if bc and bc["display_header"] in df_filt.columns:
                    vals = df_filt[bc["display_header"]].fillna("").astype(str).str.strip()
                    cnt = int((~vals.isin(["", "-"])).sum())
                else:
                    cnt = 0
            percents.append(_safe_float(cnt / n * 100))
            counts.append(cnt)
        rows.append(_Row(label, percents, counts))
    return rows


@router.post("/report/generate", response_model=ReportGenerateResponse, summary="レポートページ生成")
async def generate_report(body: ReportGenerateRequest) -> ReportGenerateResponse:
    step2_data = survey_cache.get_step2(body.session_token)
    if not step2_data:
        raise HTTPException(404, "STEP2データが見つかりません。先に回答データをアップロードしてください。")

    questions = survey_cache.get_questions(body.session_token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。")

    parquet_path = step2_data.get("labeled_parquet_path")
    if not parquet_path:
        raise HTTPException(422, "ラベル変換済みデータがありません。")

    try:
        df_full = load_parquet(Path(parquet_path))
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。再アップロードしてください。")

    q_map = {q.question_code: q for q in questions}

    # bracket列
    bracket_columns: list[dict] = step2_data.get("bracket_columns", [])
    bracket_by_base: dict[str, list[dict]] = defaultdict(list)
    for bc in bracket_columns:
        bracket_by_base[bc["base_code"]].append(bc)
    for bcs in bracket_by_base.values():
        bcs.sort(key=lambda b: b["choice_no"])

    pages: list[ReportPageData] = []
    warnings: list[str] = []

    # MA 設問を分析対象列として使う場合の共通フラグ
    is_ma_tgt = _is_ma_target(body.target_column, q_map)
    target_col_valid = bool(body.target_column) and (
        body.target_column in df_full.columns
        or (is_ma_tgt and bool(bracket_by_base.get(body.target_column)))
    )

    for q_code in body.question_codes:
        q = q_map.get(q_code)
        if q is None:
            continue
        tc = q.type_code.upper()
        if tc in _SKIP_TYPES:
            continue

        theme = _short_label(q)

        for axis_spec in body.axis_specs:
            if axis_spec.type == "total":
                axis_label = "全体"
                axis_code = ""
            else:
                axis_q = q_map.get(axis_spec.column_code)
                axis_label = axis_q.question_text if axis_q else axis_spec.column_code
                axis_code = axis_spec.column_code
                if axis_code not in df_full.columns:
                    warnings.append(f"軸列 '{axis_code}' がデータに存在しないためスキップしました。")
                    continue

            page_id = _make_page_id(body.mode, q_code, axis_code)

            # =============================================
            # 比較レポート
            # =============================================
            if body.mode == "comparison":

                if axis_spec.type == "total":
                    # 比較+全体: target_column を軸としてクロス集計
                    if target_col_valid:
                        tgt_q = q_map.get(body.target_column)
                        if is_ma_tgt:
                            axis_cats = body.target_values or [
                                b["choice_label"] for b in bracket_by_base.get(body.target_column, [])
                            ]
                            axis_totals = [
                                _ma_axis_total(df_full, body.target_column, cat, bracket_by_base)
                                for cat in axis_cats
                            ]
                            raw_rows = _crosstab_with_ma_axis(
                                df_full, q_code, tc,
                                bracket_by_base.get(q_code, []),
                                body.target_column, axis_cats, bracket_by_base,
                            )
                        else:
                            axis_cats = body.target_values if body.target_values else \
                                _build_axis_cats(df_full, body.target_column, tgt_q)
                            axis_totals = [int((df_full[body.target_column] == cat).sum()) for cat in axis_cats]

                            if tc in _CROSSTAB_SA_TYPES:
                                if q_code not in df_full.columns:
                                    warnings.append(f"列 '{q_code}' がデータに存在しないためスキップしました。")
                                    continue
                                raw_rows = _crosstab_sa(df_full, q_code, body.target_column, axis_cats)
                            elif tc in _CROSSTAB_MA_TYPES:
                                bcs = bracket_by_base.get(q_code, [])
                                raw_rows = _crosstab_ma(df_full, bcs, body.target_column, axis_cats)
                            else:
                                continue

                        rows = [ReportRow(label=r.label, percents=r.percents, counts=r.counts) for r in raw_rows]
                        title = f"{theme}：{axis_label}"
                        pages.append(ReportPageData(
                            page_id=page_id,
                            mode=body.mode,
                            title=title,
                            question_code=q_code,
                            question_text=q.question_text,
                            type_code=q.type_code,
                            axis_code=body.target_column,
                            axis_label=axis_label,
                            axis_categories=axis_cats,
                            axis_totals=axis_totals,
                            rows=rows,
                            comparison_datasets=[],
                        ))
                    else:
                        # target_column なし → 全体集計（比較なし）
                        tgt_bcs = bracket_by_base.get(q_code, [])
                        rows, n = _crosstab_total(df_full, q_code, q.type_code, tgt_bcs)
                        title = f"{theme}：{axis_label}"
                        pages.append(ReportPageData(
                            page_id=page_id,
                            mode=body.mode,
                            title=title,
                            question_code=q_code,
                            question_text=q.question_text,
                            type_code=q.type_code,
                            axis_code="",
                            axis_label=axis_label,
                            axis_categories=["全体"],
                            axis_totals=[n],
                            rows=rows,
                            comparison_datasets=[],
                        ))

                else:
                    # 比較+軸: 対象値ごとにフィルタ → スモールマルチプル
                    axis_q = q_map.get(axis_code)
                    comparison_datasets: list[ReportComparisonDataset] = []
                    target_list = body.target_values if body.target_values else []

                    if target_col_valid and target_list:
                        for tv in target_list:
                            if is_ma_tgt:
                                df_filt = _filter_by_ma_choice(df_full, body.target_column, tv, bracket_by_base)
                                if df_filt is None or df_filt.empty:
                                    continue
                            else:
                                df_filt = df_full[df_full[body.target_column] == tv]
                                if df_filt.empty:
                                    continue
                            ax_cats = _build_axis_cats(df_filt, axis_code, axis_q)
                            ax_totals = [int((df_filt[axis_code] == cat).sum()) for cat in ax_cats]

                            if tc in _CROSSTAB_SA_TYPES:
                                if q_code not in df_filt.columns:
                                    continue
                                raw = _crosstab_sa(df_filt, q_code, axis_code, ax_cats)
                            elif tc in _CROSSTAB_MA_TYPES:
                                bcs = bracket_by_base.get(q_code, [])
                                raw = _crosstab_ma(df_filt, bcs, axis_code, ax_cats)
                            else:
                                continue

                            comparison_datasets.append(ReportComparisonDataset(
                                target_value=tv,
                                axis_categories=ax_cats,
                                axis_totals=ax_totals,
                                rows=[ReportRow(label=r.label, percents=r.percents, counts=r.counts) for r in raw],
                            ))
                    else:
                        # target_column なし → 1つのデータセットで全体軸集計
                        ax_cats = _build_axis_cats(df_full, axis_code, axis_q)
                        ax_totals = [int((df_full[axis_code] == cat).sum()) for cat in ax_cats]
                        if tc in _CROSSTAB_SA_TYPES and q_code in df_full.columns:
                            raw = _crosstab_sa(df_full, q_code, axis_code, ax_cats)
                        elif tc in _CROSSTAB_MA_TYPES:
                            raw = _crosstab_ma(df_full, bracket_by_base.get(q_code, []), axis_code, ax_cats)
                        else:
                            raw = []
                        comparison_datasets.append(ReportComparisonDataset(
                            target_value="全体",
                            axis_categories=ax_cats,
                            axis_totals=ax_totals,
                            rows=[ReportRow(label=r.label, percents=r.percents, counts=r.counts) for r in raw],
                        ))

                    if not comparison_datasets:
                        continue

                    title = f"{theme}：{axis_label}"
                    pages.append(ReportPageData(
                        page_id=page_id,
                        mode=body.mode,
                        title=title,
                        question_code=q_code,
                        question_text=q.question_text,
                        type_code=q.type_code,
                        axis_code=axis_code,
                        axis_label=axis_label,
                        axis_categories=[],
                        axis_totals=[],
                        rows=[],
                        comparison_datasets=comparison_datasets,
                    ))

            # =============================================
            # 単一対象レポート
            # =============================================
            else:
                # フィルタ適用
                if target_col_valid and body.target_values:
                    tv = body.target_values[0]
                    if is_ma_tgt:
                        df_work = _filter_by_ma_choice(df_full, body.target_column, tv, bracket_by_base)
                        if df_work is None:
                            df_work = df_full.iloc[0:0]
                    else:
                        df_work = df_full[df_full[body.target_column] == tv]
                    target_label = tv
                else:
                    df_work = df_full
                    target_label = "全体"

                if df_work.empty:
                    warnings.append(f"対象値 '{body.target_values[0] if body.target_values else ''}' のデータが見つかりませんでした。")
                    continue

                if axis_spec.type == "total":
                    bcs = bracket_by_base.get(q_code, [])
                    rows, n = _crosstab_total(df_work, q_code, q.type_code, bcs)
                    title = f"{target_label}｜{theme}：{axis_label}"
                    pages.append(ReportPageData(
                        page_id=page_id,
                        mode=body.mode,
                        title=title,
                        question_code=q_code,
                        question_text=q.question_text,
                        type_code=q.type_code,
                        axis_code="",
                        axis_label=axis_label,
                        axis_categories=["全体"],
                        axis_totals=[n],
                        rows=rows,
                        comparison_datasets=[],
                    ))
                else:
                    axis_q = q_map.get(axis_code)
                    ax_cats = _build_axis_cats(df_work, axis_code, axis_q)
                    ax_totals = [int((df_work[axis_code] == cat).sum()) for cat in ax_cats]

                    if tc in _CROSSTAB_SA_TYPES:
                        if q_code not in df_work.columns:
                            warnings.append(f"列 '{q_code}' がデータに存在しないためスキップしました。")
                            continue
                        raw = _crosstab_sa(df_work, q_code, axis_code, ax_cats)
                    elif tc in _CROSSTAB_MA_TYPES:
                        bcs = bracket_by_base.get(q_code, [])
                        raw = _crosstab_ma(df_work, bcs, axis_code, ax_cats)
                    else:
                        continue

                    rows = [ReportRow(label=r.label, percents=r.percents, counts=r.counts) for r in raw]
                    title = f"{target_label}｜{theme}：{axis_label}"
                    pages.append(ReportPageData(
                        page_id=page_id,
                        mode=body.mode,
                        title=title,
                        question_code=q_code,
                        question_text=q.question_text,
                        type_code=q.type_code,
                        axis_code=axis_code,
                        axis_label=axis_label,
                        axis_categories=ax_cats,
                        axis_totals=ax_totals,
                        rows=rows,
                        comparison_datasets=[],
                    ))

    logger.info(
        "レポート生成完了: mode=%s, 設問数=%d, ページ数=%d, 警告=%d",
        body.mode, len(body.question_codes), len(pages), len(warnings),
    )

    return ReportGenerateResponse(pages=pages, warnings=warnings)

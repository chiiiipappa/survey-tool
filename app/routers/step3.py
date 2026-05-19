"""STEP3: クロス集計エンドポイント。"""

from __future__ import annotations

import logging
import math
from collections import defaultdict

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.data_store import survey_cache
from app.schemas import (
    CrosstabResult,
    CrosstabRow,
    Step3CrosstabRequest,
    Step3CrosstabResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# SA / MA / 数値系のみクロス集計対象。FAは除外。
_CROSSTAB_SA_TYPES = {"SA", "S", "NU", "N"}
_CROSSTAB_MA_TYPES = {"MA", "ML"}
_SKIP_TYPES = {"FA", "OA", "OE", "FT", "FN"}


def _safe_float(val: float) -> float:
    """NaN / Inf を 0.0 に変換する。"""
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return round(val, 1)


def _crosstab_sa(
    df: pd.DataFrame,
    q_col: str,
    axis_col: str,
    axis_cats: list[str],
) -> list[CrosstabRow]:
    """SA/数値設問のクロス集計行を生成する。"""
    sub = df[[q_col, axis_col]].copy()
    sub = sub[sub[axis_col].isin(axis_cats)]  # 軸の有効カテゴリーのみ

    if sub.empty:
        return []

    ct = pd.crosstab(sub[q_col], sub[axis_col])
    # 軸カテゴリー順に列を並べ、足りない列は 0 補完
    ct = ct.reindex(columns=axis_cats, fill_value=0)

    # N数（軸カテゴリーごと）
    col_totals = ct.sum(axis=0)

    rows: list[CrosstabRow] = []
    for label, row in ct.iterrows():
        counts = [int(row[cat]) for cat in axis_cats]
        percents = [
            _safe_float(c / col_totals[cat] * 100) if col_totals[cat] > 0 else 0.0
            for c, cat in zip(counts, axis_cats)
        ]
        rows.append(CrosstabRow(label=str(label), counts=counts, percents=percents))

    return rows


def _crosstab_ma(
    df: pd.DataFrame,
    bracket_cols: list[dict],
    axis_col: str,
    axis_cats: list[str],
) -> list[CrosstabRow]:
    """MA設問のクロス集計行を生成する（各選択肢のbracket列を使用）。"""
    sub = df[df[axis_col].isin(axis_cats)]
    col_totals = sub[axis_col].value_counts().reindex(axis_cats, fill_value=0)

    rows: list[CrosstabRow] = []
    for bc in bracket_cols:
        display_col = bc["display_header"]
        if display_col not in df.columns:
            continue

        answered = sub[display_col].notna() & (sub[display_col].astype(str).str.strip() != "")
        grp = answered.groupby(sub[axis_col]).sum().reindex(axis_cats, fill_value=0)

        counts = [int(grp[cat]) for cat in axis_cats]
        percents = [
            _safe_float(c / col_totals[cat] * 100) if col_totals[cat] > 0 else 0.0
            for c, cat in zip(counts, axis_cats)
        ]
        rows.append(CrosstabRow(
            label=bc["choice_label"],
            counts=counts,
            percents=percents,
        ))

    return rows


@router.post("/step3/crosstab", response_model=Step3CrosstabResponse, summary="クロス集計実行")
async def run_crosstab(body: Step3CrosstabRequest) -> Step3CrosstabResponse:
    """STEP2のラベル変換済みデータを使ってクロス集計を行う。"""
    step2_data = survey_cache.get_step2(body.session_token)
    if not step2_data:
        raise HTTPException(404, "STEP2データが見つかりません。先に回答データをアップロードしてください。")

    questions = survey_cache.get_questions(body.session_token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。")

    labeled_data = step2_data.get("labeled_data", {})
    if not labeled_data:
        raise HTTPException(422, "ラベル変換済みデータがありません。")

    df = pd.DataFrame(labeled_data)
    axis_col = body.axis_question_code

    if axis_col not in df.columns:
        raise HTTPException(422, f"集計軸列 '{axis_col}' がデータに存在しません。")

    # 軸の設問情報を取得
    axis_q = next((q for q in questions if q.question_code == axis_col), None)
    axis_question_text = axis_q.question_text if axis_q else axis_col

    # 軸カテゴリーを決定（欠損除外、出現順）
    axis_series = df[axis_col].dropna().astype(str)
    axis_series = axis_series[axis_series.str.strip() != ""]
    axis_cats = list(axis_series.value_counts().index)  # 頻度降順

    # choices 順があれば choices の順番を優先
    if axis_q and axis_q.choices:
        choice_labels = [c.choice_text for c in axis_q.choices]
        ordered = [lbl for lbl in choice_labels if lbl in set(axis_cats)]
        remaining = [lbl for lbl in axis_cats if lbl not in set(choice_labels)]
        axis_cats = ordered + remaining

    axis_totals = [
        int((df[axis_col] == cat).sum()) for cat in axis_cats
    ]

    # bracket_columns を base_code でグループ化
    bracket_columns: list[dict] = step2_data.get("bracket_columns", [])
    bracket_by_base: dict[str, list[dict]] = defaultdict(list)
    for bc in bracket_columns:
        bracket_by_base[bc["base_code"]].append(bc)
    for bcs in bracket_by_base.values():
        bcs.sort(key=lambda b: b["choice_no"])

    # 対象設問を決定
    q_map = {q.question_code: q for q in questions}
    if body.target_question_codes:
        target_codes = [c for c in body.target_question_codes if c in q_map]
    else:
        target_codes = [q.question_code for q in questions if q.question_code != axis_col]

    results: list[CrosstabResult] = []
    warnings: list[str] = []

    for code in target_codes:
        q = q_map.get(code)
        if q is None:
            continue

        tc = q.type_code.upper()

        if tc in _SKIP_TYPES:
            continue

        if tc in _CROSSTAB_SA_TYPES:
            if code not in df.columns:
                warnings.append(f"列 '{code}' がデータに存在しないためスキップしました。")
                continue
            rows = _crosstab_sa(df, code, axis_col, axis_cats)
            if not rows:
                continue
            results.append(CrosstabResult(
                question_code=code,
                question_text=q.question_text,
                type_code=q.type_code,
                rows=rows,
            ))

        elif tc in _CROSSTAB_MA_TYPES:
            bcs = bracket_by_base.get(code, [])
            if not bcs:
                warnings.append(f"MA設問 '{code}' のbracket列が見つかりませんでした。")
                continue
            rows = _crosstab_ma(df, bcs, axis_col, axis_cats)
            if not rows:
                continue
            results.append(CrosstabResult(
                question_code=code,
                question_text=q.question_text,
                type_code=q.type_code,
                rows=rows,
            ))

    logger.info(
        "クロス集計完了: axis=%s, 設問数=%d, 警告=%d",
        axis_col, len(results), len(warnings),
    )

    return Step3CrosstabResponse(
        axis_question_code=axis_col,
        axis_question_text=axis_question_text,
        axis_categories=axis_cats,
        axis_totals=axis_totals,
        results=results,
        warnings=warnings,
    )

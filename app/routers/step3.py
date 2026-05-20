"""STEP3: クロス集計エンドポイント。"""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, HTTPException

from app.data_store import survey_cache
from app.parquet_cache import load_parquet
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
_CROSSTAB_MA_TYPES = {"MA", "ML", "M"}
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

        # "-" は convert_labels が 0（未選択）に付けるラベル。空文字・NaN とともに除外する。
        val_str = sub[display_col].fillna("").astype(str).str.strip()
        answered = ~val_str.isin(["", "-"])
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


_COMPOSITE_SEP = " × "


def _build_axis_cats(df: pd.DataFrame, col: str, q) -> list[str]:
    """設問列から軸カテゴリーリストを choices 順で生成する。"""
    series = df[col].dropna().astype(str)
    series = series[series.str.strip() != ""]
    cats = list(series.value_counts().index)
    if q and q.choices:
        choice_labels = [c.choice_text for c in q.choices]
        ordered = [lbl for lbl in choice_labels if lbl in set(cats)]
        remaining = [lbl for lbl in cats if lbl not in set(choice_labels)]
        cats = ordered + remaining
    return cats


def _resolve_needed_columns(
    body: Step3CrosstabRequest,
    step2_data: dict,
) -> list[str] | None:
    """クロス集計に必要な列名リストを返す。target_question_codes が空なら None（全列読込）。"""
    if not body.target_question_codes:
        return None

    # bracket列: base_code → [display_header, ...]（MA設問の展開列名）
    bracket_map: dict[str, list[str]] = {}
    for bc in step2_data.get("bracket_columns", []):
        bracket_map.setdefault(bc["base_code"], []).append(bc["display_header"])

    needed: set[str] = {body.axis_question_code}
    if body.secondary_axis_question_code:
        needed.add(body.secondary_axis_question_code)

    for code in body.target_question_codes:
        if code in bracket_map:
            needed.update(bracket_map[code])
        else:
            needed.add(code)

    return list(needed)


@router.post("/step3/crosstab", response_model=Step3CrosstabResponse, summary="クロス集計実行")
async def run_crosstab(body: Step3CrosstabRequest) -> Step3CrosstabResponse:
    """STEP2のラベル変換済みデータを使ってクロス集計を行う。"""
    step2_data = survey_cache.get_step2(body.session_token)
    if not step2_data:
        raise HTTPException(404, "STEP2データが見つかりません。先に回答データをアップロードしてください。")

    questions = survey_cache.get_questions(body.session_token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。")

    parquet_path = step2_data.get("labeled_parquet_path")
    if not parquet_path:
        raise HTTPException(422, "ラベル変換済みデータがありません。")

    columns_needed = _resolve_needed_columns(body, step2_data)
    try:
        df = load_parquet(Path(parquet_path), columns=columns_needed)
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。再アップロードしてください。")
    axis_col = body.axis_question_code

    if axis_col not in df.columns:
        raise HTTPException(422, f"集計軸列 '{axis_col}' がデータに存在しません。")

    # 軸の設問情報を取得
    q_map = {q.question_code: q for q in questions}
    axis_q = q_map.get(axis_col)
    axis_question_text = axis_q.question_text if axis_q else axis_col

    # 軸①カテゴリーを決定
    axis_cats = _build_axis_cats(df, axis_col, axis_q)
    axis_totals = [int((df[axis_col] == cat).sum()) for cat in axis_cats]

    # 複合軸: 軸② が指定されている場合
    primary_axis_cats: list[str] = []    # axis2 の値（外ループ）
    secondary_axis_cats: list[str] = []  # axis1 の値（内ループ）
    secondary_axis_code = body.secondary_axis_question_code or ""
    secondary_axis_q = None

    if secondary_axis_code:
        if secondary_axis_code not in df.columns:
            raise HTTPException(422, f"集計軸②列 '{secondary_axis_code}' がデータに存在しません。")
        secondary_axis_q = q_map.get(secondary_axis_code)
        sec_cats = _build_axis_cats(df, secondary_axis_code, secondary_axis_q)

        # primary = axis2 (外ループ), secondary = axis1 (内ループ)
        primary_axis_cats = sec_cats
        secondary_axis_cats = axis_cats

        # 複合列生成: "axis2値 × axis1値"
        df["__composite__"] = (
            df[secondary_axis_code].fillna("").astype(str)
            + _COMPOSITE_SEP
            + df[axis_col].fillna("").astype(str)
        )
        axis_cats = [
            f"{p}{_COMPOSITE_SEP}{s}"
            for p in primary_axis_cats
            for s in secondary_axis_cats
        ]
        axis_totals = [int((df["__composite__"] == cat).sum()) for cat in axis_cats]
        axis_col = "__composite__"

    # bracket_columns を base_code でグループ化
    bracket_columns: list[dict] = step2_data.get("bracket_columns", [])
    bracket_by_base: dict[str, list[dict]] = defaultdict(list)
    for bc in bracket_columns:
        bracket_by_base[bc["base_code"]].append(bc)
    for bcs in bracket_by_base.values():
        bcs.sort(key=lambda b: b["choice_no"])

    # 対象設問を決定（元の axis_question_code と secondary_axis を除外）
    orig_axis_col = body.axis_question_code
    if body.target_question_codes:
        target_codes = [c for c in body.target_question_codes if c in q_map]
    else:
        exclude = {orig_axis_col, secondary_axis_code}
        target_codes = [q.question_code for q in questions if q.question_code not in exclude]

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
        "クロス集計完了: axis=%s, secondary=%s, 設問数=%d, 警告=%d",
        body.axis_question_code, secondary_axis_code, len(results), len(warnings),
    )

    return Step3CrosstabResponse(
        axis_question_code=body.axis_question_code,
        axis_question_text=axis_question_text,
        axis_categories=axis_cats,
        axis_totals=axis_totals,
        results=results,
        warnings=warnings,
        secondary_axis_question_code=secondary_axis_code,
        secondary_axis_question_text=(
            secondary_axis_q.question_text if secondary_axis_q else ""
        ),
        primary_axis_categories=primary_axis_cats,
        secondary_axis_categories=secondary_axis_cats,
    )

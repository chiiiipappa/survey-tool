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
    AvgIndicatorResult,
    AverageAxisStat,
    CrosstabResult,
    CrosstabRow,
    Step3CrosstabRequest,
    Step3CrosstabResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# SA / MA / 数値系のみクロス集計対象。FAは除外。SLはサブ設問が1列1値なのでSA相当。
_CROSSTAB_SA_TYPES = {"SA", "S", "NU", "N", "SL"}
_CROSSTAB_MA_TYPES = {"MA", "ML", "M"}
_SKIP_TYPES = {"FA", "OA", "OE", "FT", "FN", "XL", "F"}


def _safe_float(val: float) -> float:
    """NaN / Inf を 0.0 に変換する。"""
    if math.isnan(val) or math.isinf(val):
        return 0.0
    return round(val, 1)


def _norm_code(v) -> str:
    """数値コードを正規化して文字列に変換する（float "10.0" → "10"）。"""
    try:
        return str(int(float(str(v))))
    except (ValueError, TypeError):
        return str(v)


def _build_code_to_label(q) -> dict[str, str]:
    """choice_index → choice_text のマッピングを構築する。"""
    if not (q and q.choices):
        return {}
    return {_norm_code(c.choice_index): c.choice_text for c in q.choices}


def _crosstab_sa(
    df: pd.DataFrame,
    q_col: str,
    axis_col: str,
    axis_cats: list[str],
    q=None,
) -> list[CrosstabRow]:
    """SA/数値設問のクロス集計行を生成する。"""
    sub = df[[q_col, axis_col]].copy()
    sub = sub[sub[axis_col].isin(axis_cats)]  # 軸の有効カテゴリーのみ

    if sub.empty:
        return []

    ct = pd.crosstab(sub[q_col], sub[axis_col])
    # 軸カテゴリー順に列を並べ、足りない列は 0 補完
    ct = ct.reindex(columns=axis_cats, fill_value=0)

    # STEP1の全選択肢を行として使用（_build_axis_cats と同一ロジック）
    if q and q.choices:
        choice_labels = [c.choice_text for c in q.choices]
        # choice_index の数値コード → choice_text へリマップしてからreindex
        code_to_label = _build_code_to_label(q)
        ct.index = pd.Index([
            code_to_label.get(_norm_code(idx), str(idx)) for idx in ct.index
        ])
        # 同一ラベルが複数行になった場合は集約
        ct = ct.groupby(level=0).sum()
        s1_set = set(choice_labels)
        remaining = [lbl for lbl in ct.index if lbl not in s1_set]
        ct = ct.reindex(choice_labels + remaining, fill_value=0)

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


def _crosstab_total(
    df: pd.DataFrame,
    q_code: str,
    type_code: str,
    bracket_cols: list[dict],
    q=None,
) -> tuple[list[CrosstabRow], int]:
    """軸なし全体集計。(rows, total_n) を返す。"""
    tc = type_code.upper()
    n = len(df)
    rows: list[CrosstabRow] = []

    if tc in _CROSSTAB_SA_TYPES:
        if q_code not in df.columns:
            return [], n
        vc = df[q_code].value_counts()
        # choice_index → choice_text マッピングで数値コードをラベルに変換
        code_to_label = _build_code_to_label(q)
        # コードをラベルに変換してグループ集計
        label_series = vc.index.map(lambda k: code_to_label.get(_norm_code(k), str(k)))
        vc_mapped = vc.groupby(label_series).sum()
        # STEP1の選択肢順に並べ替え
        if q and q.choices:
            choice_labels = [c.choice_text for c in q.choices]
            s1_set = set(choice_labels)
            remaining = [lbl for lbl in vc_mapped.index if lbl not in s1_set]
            ordered_labels = [lbl for lbl in choice_labels if lbl in vc_mapped.index] + remaining
            vc_mapped = vc_mapped.reindex(ordered_labels, fill_value=0)
        for label, cnt in vc_mapped.items():
            pct = _safe_float(cnt / n * 100) if n > 0 else 0.0
            rows.append(CrosstabRow(label=str(label), counts=[int(cnt)], percents=[pct]))

    elif tc in _CROSSTAB_MA_TYPES:
        for bc in bracket_cols:
            dcol = bc["display_header"]
            if dcol not in df.columns:
                continue
            val_str = df[dcol].fillna("").astype(str).str.strip()
            cnt = int((~val_str.isin(["", "-"])).sum())
            pct = _safe_float(cnt / n * 100) if n > 0 else 0.0
            rows.append(CrosstabRow(label=bc["choice_label"], counts=[cnt], percents=[pct]))

    return rows, n


_COMPOSITE_SEP = " × "


def _build_axis_cats(df: pd.DataFrame, col: str, q) -> list[str]:
    """軸カテゴリーリストを生成する。

    STEP1設問マスタの選択肢を必ず使用する（データに存在しない選択肢も含む）。
    STEP1定義がない場合のみデータから生成する。
    """
    series = df[col].dropna().astype(str)
    series = series[series.str.strip() != ""]
    data_cats = set(series.unique())

    if q and q.choices:
        choice_labels = [c.choice_text for c in q.choices]
        logger.info(
            "axis_cats[%s]: STEP1 choices=%d, data unique=%d",
            col, len(choice_labels), len(data_cats),
        )
        if len(data_cats) < len(choice_labels):
            logger.warning(
                "axis_cats[%s]: STEP1 choices=%d に対しデータ一意値=%d — "
                "ラベル変換が一部失敗している可能性があります。データ値サンプル: %s",
                col, len(choice_labels), len(data_cats),
                sorted(data_cats)[:10],
            )
        # STEP1の全選択肢を軸として使用し、データにしか存在しない値は末尾に追加
        s1_set = set(choice_labels)
        remaining = sorted(v for v in data_cats if v not in s1_set)
        return choice_labels + remaining

    cats = list(series.value_counts().index)
    logger.info("axis_cats[%s]: STEP1選択肢定義なし、データから %d カテゴリ生成", col, len(cats))
    return cats


def _build_bracket_by_base(step2_data: dict) -> dict[str, list[dict]]:
    """bracket_columns を base_code でグループ化（choice_no 昇順）して返す。"""
    bracket_by_base: dict[str, list[dict]] = defaultdict(list)
    for bc in step2_data.get("bracket_columns", []):
        bracket_by_base[bc["base_code"]].append(bc)
    for bcs in bracket_by_base.values():
        bcs.sort(key=lambda b: b["choice_no"])
    return dict(bracket_by_base)


def _resolve_needed_columns(
    body: Step3CrosstabRequest,
    step2_data: dict,
    bracket_by_base: dict[str, list[dict]] | None = None,
) -> list[str] | None:
    """クロス集計に必要な列名リストを返す。target_question_codes が空なら None（全列読込）。"""
    if not body.target_question_codes:
        return None

    # bracket列: base_code → [display_header, ...]（MA設問の展開列名）
    bracket_map: dict[str, list[str]] = {}
    bracket_headers: set[str] = set()
    for bc in step2_data.get("bracket_columns", []):
        bracket_map.setdefault(bc["base_code"], []).append(bc["display_header"])
        bracket_headers.add(bc["display_header"])

    # parquet に存在する列 = matched_columns（直接コード）＋ bracket display_header
    matched_set = set(step2_data.get("matched_columns", []))
    available = matched_set | bracket_headers

    # 軸列の追加（bracket MA軸の場合は展開列を追加）
    needed: set[str] = set()
    axis_code = body.axis_question_code
    if axis_code in bracket_map:
        needed.update(bracket_map[axis_code])
    else:
        needed.add(axis_code)

    if body.secondary_axis_question_code:
        sec = body.secondary_axis_question_code
        if sec in bracket_map:
            needed.update(bracket_map[sec])
        else:
            needed.add(sec)

    for code in body.target_question_codes:
        if code in bracket_map:
            needed.update(bracket_map[code])
        elif code in available:
            needed.add(code)

    # 分析対象フィルタ列も追加
    if body.target_filter_column:
        fc = body.target_filter_column
        if fc in bracket_map:
            needed.update(bracket_map[fc])
        elif fc in available:
            needed.add(fc)

    # 平均点指標列も追加
    for indicator_code in body.avg_indicator_codes:
        if indicator_code in available:
            needed.add(indicator_code)

    return list(needed)


def _crosstab_sa_bracket_axis(
    df: pd.DataFrame,
    q_col: str,
    bcs_axis: list[dict],
    axis_cats: list[str],
    axis_totals: list[int],
    q,
) -> list[CrosstabRow]:
    """SA設問のクロス集計（bracket MA が集計軸の場合）。"""
    if q_col not in df.columns:
        return []
    values = _build_axis_cats(df, q_col, q)
    if not values:
        return []

    rows: list[CrosstabRow] = []
    for val in values:
        target_mask = df[q_col].astype(str) == val
        counts: list[int] = []
        percents: list[float] = []
        for bc, total in zip(bcs_axis, axis_totals):
            dcol = bc["display_header"]
            if dcol not in df.columns:
                counts.append(0)
                percents.append(0.0)
                continue
            sel_mask = ~df[dcol].fillna("").astype(str).str.strip().isin(["", "-"])
            c = int((target_mask & sel_mask).sum())
            p = _safe_float(c / total * 100) if total > 0 else 0.0
            counts.append(c)
            percents.append(p)
        rows.append(CrosstabRow(label=str(val), counts=counts, percents=percents))
    return rows


def _crosstab_ma_bracket_axis(
    df: pd.DataFrame,
    bcs_target: list[dict],
    bcs_axis: list[dict],
    axis_cats: list[str],
    axis_totals: list[int],
) -> list[CrosstabRow]:
    """MA設問のクロス集計（bracket MA が集計軸の場合）。"""
    rows: list[CrosstabRow] = []
    for bc_target in bcs_target:
        dcol_t = bc_target["display_header"]
        if dcol_t not in df.columns:
            continue
        target_mask = ~df[dcol_t].fillna("").astype(str).str.strip().isin(["", "-"])
        counts: list[int] = []
        percents: list[float] = []
        for bc_axis, total in zip(bcs_axis, axis_totals):
            dcol_a = bc_axis["display_header"]
            if dcol_a not in df.columns:
                counts.append(0)
                percents.append(0.0)
                continue
            sel_mask = ~df[dcol_a].fillna("").astype(str).str.strip().isin(["", "-"])
            c = int((target_mask & sel_mask).sum())
            p = _safe_float(c / total * 100) if total > 0 else 0.0
            counts.append(c)
            percents.append(p)
        rows.append(CrosstabRow(label=bc_target["choice_label"], counts=counts, percents=percents))
    return rows


def _compute_avg_indicator_results(
    df: pd.DataFrame,
    q_map: dict,
    avg_indicator_codes: list[str],
    axis_col: str,
    axis_cats: list[str],
    axis_totals: list[int],
) -> list[AvgIndicatorResult]:
    """数値指標列を基本軸カテゴリ別に集計し AvgIndicatorResult リストを返す。"""
    results: list[AvgIndicatorResult] = []
    for code in avg_indicator_codes:
        if code not in df.columns:
            continue
        q = q_map.get(code)
        indicator_name = q.question_text if q else code
        stats: list[AverageAxisStat] = []
        for cat, total in zip(axis_cats, axis_totals):
            scores = pd.to_numeric(df.loc[df[axis_col] == cat, code], errors="coerce").dropna()
            n_valid = int(scores.shape[0])
            n_excluded = max(total - n_valid, 0)
            if n_valid == 0:
                stats.append(AverageAxisStat(category=cat, n_valid=0, n_excluded=n_excluded))
            else:
                stats.append(AverageAxisStat(
                    category=cat,
                    n_valid=n_valid,
                    n_excluded=n_excluded,
                    mean=_safe_float(float(scores.mean())),
                    std=_safe_float(float(scores.std())) if n_valid > 1 else 0.0,
                    median=_safe_float(float(scores.median())),
                    min=_safe_float(float(scores.min())),
                    max=_safe_float(float(scores.max())),
                ))
        results.append(AvgIndicatorResult(indicator_code=code, indicator_name=indicator_name, stats=stats))
    return results


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

    # bracket_by_base を早期に構築（軸タイプ判定に使用）
    bracket_by_base = _build_bracket_by_base(step2_data)

    columns_needed = _resolve_needed_columns(body, step2_data, bracket_by_base)
    try:
        df = load_parquet(Path(parquet_path), columns=columns_needed)
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。再アップロードしてください。")
    except Exception as exc:
        logger.warning("列プロジェクション失敗、全列ロードにフォールバック: %s", exc)
        try:
            df = load_parquet(Path(parquet_path))
        except FileNotFoundError:
            raise HTTPException(422, "データが失われています。再アップロードしてください。")

    axis_col_raw = body.axis_question_code
    q_map = {q.question_code: q for q in questions}
    axis_q = q_map.get(axis_col_raw)
    axis_question_text = axis_q.question_text if axis_q else axis_col_raw

    # 分析対象フィルタ（df 絞り込み — 軸カテゴリー計算前に適用）
    if body.target_filter_column and body.target_filter_values:
        tcol = body.target_filter_column
        tvals = body.target_filter_values
        if tcol in bracket_by_base:
            mask = pd.Series(False, index=df.index)
            for val in tvals:
                bc = next((b for b in bracket_by_base[tcol] if b["choice_label"] == val), None)
                if bc and bc["display_header"] in df.columns:
                    col_h = bc["display_header"]
                    mask |= ~df[col_h].fillna("").astype(str).str.strip().isin(["", "-"])
            df = df[mask]
        elif tcol in df.columns:
            df = df[df[tcol].isin(tvals)]

    # bracket MA軸かどうかを判定
    is_bracket_ma_axis = (axis_col_raw not in df.columns) and (axis_col_raw in bracket_by_base)

    # --- bracket MA軸モード ---
    if is_bracket_ma_axis:
        bcs_axis = [bc for bc in bracket_by_base[axis_col_raw] if bc["display_header"] in df.columns]
        if not bcs_axis:
            raise HTTPException(422, f"集計軸設問 '{axis_col_raw}' の展開列がデータに存在しません。")

        axis_cats = [bc["choice_label"] for bc in bcs_axis]
        axis_totals: list[int] = []
        for bc in bcs_axis:
            sel = ~df[bc["display_header"]].fillna("").astype(str).str.strip().isin(["", "-"])
            axis_totals.append(int(sel.sum()))

        # bracket MA軸は複合軸非対応
        primary_axis_cats: list[str] = []
        secondary_axis_cats: list[str] = []
        secondary_axis_code = ""
        secondary_axis_q = None

        orig_axis_col = axis_col_raw
        if body.target_question_codes:
            target_codes = [c for c in body.target_question_codes if c in q_map]
        else:
            exclude = {orig_axis_col}
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
                rows = _crosstab_sa_bracket_axis(df, code, bcs_axis, axis_cats, axis_totals, q)
            elif tc in _CROSSTAB_MA_TYPES:
                bcs = bracket_by_base.get(code, [])
                if not bcs:
                    warnings.append(f"MA設問 '{code}' のbracket列が見つかりませんでした。")
                    continue
                rows = _crosstab_ma_bracket_axis(df, bcs, bcs_axis, axis_cats, axis_totals)
            else:
                continue

            if rows:
                results.append(CrosstabResult(
                    question_code=code,
                    question_text=q.question_text,
                    type_code=q.type_code,
                    rows=rows,
                ))

        logger.info(
            "クロス集計完了(bracket MA軸): axis=%s, 設問数=%d, 警告=%d",
            axis_col_raw, len(results), len(warnings),
        )
        return Step3CrosstabResponse(
            axis_question_code=axis_col_raw,
            axis_question_text=axis_question_text,
            axis_categories=axis_cats,
            axis_totals=axis_totals,
            results=results,
            warnings=warnings,
            secondary_axis_question_code="",
            secondary_axis_question_text="",
            primary_axis_categories=[],
            secondary_axis_categories=[],
            avg_indicator_results=[],
        )

    # --- 軸なしモード（全体集計） ---
    if not axis_col_raw:
        if body.target_question_codes:
            target_codes = [c for c in body.target_question_codes if c in q_map]
        else:
            target_codes = [q.question_code for q in questions]

        total_results: list[CrosstabResult] = []
        total_warnings: list[str] = []
        total_n = len(df)

        for code in target_codes:
            q = q_map.get(code)
            if q is None:
                continue
            tc = q.type_code.upper()
            if tc in _SKIP_TYPES:
                continue
            bcs = bracket_by_base.get(code, [])
            rows, n = _crosstab_total(df, code, q.type_code, bcs, q)
            total_n = n
            if not rows:
                continue
            total_results.append(CrosstabResult(
                question_code=code,
                question_text=q.question_text,
                type_code=q.type_code,
                rows=rows,
            ))

        logger.info("クロス集計完了(全体集計): 設問数=%d, 警告=%d", len(total_results), len(total_warnings))
        return Step3CrosstabResponse(
            axis_question_code="",
            axis_question_text="全体",
            axis_categories=["全体"],
            axis_totals=[total_n],
            results=total_results,
            warnings=total_warnings,
            secondary_axis_question_code="",
            secondary_axis_question_text="",
            primary_axis_categories=[],
            secondary_axis_categories=[],
            avg_indicator_results=[],
        )

    # --- 通常軸モード ---
    axis_col = axis_col_raw
    if axis_col not in df.columns:
        raise HTTPException(422, f"集計軸列 '{axis_col}' がデータに存在しません。")

    # 数値型の軸列（スコア指標など）を文字列に正規化して比較を統一する
    if pd.api.types.is_numeric_dtype(df[axis_col]):
        def _num_to_str(v):
            if pd.isna(v):
                return ""
            iv = int(v)
            return str(iv) if iv == v else str(v)
        df[axis_col] = df[axis_col].apply(_num_to_str)

    axis_cats = _build_axis_cats(df, axis_col, axis_q)
    axis_totals = [int((df[axis_col] == cat).sum()) for cat in axis_cats]

    primary_axis_cats = []
    secondary_axis_cats = []
    secondary_axis_code = body.secondary_axis_question_code or ""
    secondary_axis_q = None

    if secondary_axis_code:
        if secondary_axis_code not in df.columns:
            raise HTTPException(422, f"集計軸②列 '{secondary_axis_code}' がデータに存在しません。")
        secondary_axis_q = q_map.get(secondary_axis_code)
        if pd.api.types.is_numeric_dtype(df[secondary_axis_code]):
            df[secondary_axis_code] = df[secondary_axis_code].apply(_num_to_str)
        sec_cats = _build_axis_cats(df, secondary_axis_code, secondary_axis_q)

        primary_axis_cats = sec_cats
        secondary_axis_cats = axis_cats

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

    orig_axis_col = axis_col_raw
    if body.target_question_codes:
        target_codes = [c for c in body.target_question_codes if c in q_map]
    else:
        exclude = {orig_axis_col, secondary_axis_code}
        target_codes = [q.question_code for q in questions if q.question_code not in exclude]

    results = []
    warnings = []

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
            rows = _crosstab_sa(df, code, axis_col, axis_cats, q=q)
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

    # 平均点指標の軸別集計（通常軸モードのみ対応）
    avg_indicator_results: list[AvgIndicatorResult] = []
    if body.avg_indicator_codes and axis_col in df.columns:
        avg_indicator_results = _compute_avg_indicator_results(
            df, q_map, body.avg_indicator_codes, axis_col, axis_cats, axis_totals,
        )

    logger.info(
        "クロス集計完了: axis=%s, secondary=%s, 設問数=%d, 指標数=%d, 警告=%d",
        axis_col_raw, secondary_axis_code, len(results), len(avg_indicator_results), len(warnings),
    )

    return Step3CrosstabResponse(
        axis_question_code=axis_col_raw,
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
        avg_indicator_results=avg_indicator_results,
    )

"""STEP3: 特定分析（属性分析・ファン度分析・平均点分析）エンドポイント。

既存のクロス集計エンジン（app.routers.step3）の関数群を再利用し、
よく使う定型分析をワンクリックで実行できるようにする。
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.data_store import survey_cache
from app.parquet_cache import load_parquet, save_parquet
from app.step3_fan_excel import build_fan_excel_workbook
from app.routers.step3 import (
    _COMPOSITE_SEP,
    _CROSSTAB_MA_TYPES,
    _CROSSTAB_SA_TYPES,
    _SKIP_TYPES,
    _build_axis_cats,
    _build_bracket_by_base,
    _crosstab_ma,
    _crosstab_sa,
    _crosstab_total,
    _safe_float,
)
from app.schemas import (
    AttributeAnalysisRequest,
    AttributeSaveAsAxisRequest,
    AttributeSaveAsAxisResponse,
    AverageAnalysisRequest,
    AverageSaveAsIndicatorRequest,
    AverageSaveAsIndicatorResponse,
    AverageAxisStat,
    ChoiceItem,
    CrosstabResult,
    FanAnalysisRequest,
    FanAnalysisResponse,
    FanDegreeCount,
    FanDegreeMatrixCell,
    FanDegreeRespondentRow,
    FanDegreeSaveRequest,
    FanDegreeSaveResponse,
    FanDegreeSummary,
    QuestionItem,
    Step3SpecialBlock,
    Step3SpecialResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _load_session(session_token: str):
    """セッションからDataFrame・設問マスタ・bracket列マップを読み込む。"""
    step2_data = survey_cache.get_step2(session_token)
    if not step2_data:
        raise HTTPException(404, "STEP2データが見つかりません。先に回答データをアップロードしてください。")

    questions = survey_cache.get_questions(session_token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。")

    parquet_path = step2_data.get("labeled_parquet_path")
    if not parquet_path:
        raise HTTPException(422, "ラベル変換済みデータがありません。")

    try:
        df = load_parquet(Path(parquet_path))
    except FileNotFoundError:
        raise HTTPException(422, "データが失われています。再アップロードしてください。")

    q_map = {q.question_code: q for q in questions}
    bracket_by_base = _build_bracket_by_base(step2_data)
    return df, questions, q_map, bracket_by_base


def _resolve_breakdown_axis(
    df: pd.DataFrame,
    group: list[str],
    q_map: dict,
) -> tuple[str, list[str], list[int], str] | None:
    """集計軸グループ（1要素=単一軸、2要素=複合軸）を解決する。

    解決できれば (axis_col, axis_categories, axis_totals, axis_label) を返す。
    """
    if len(group) == 1:
        code = group[0]
        if code not in df.columns:
            return None
        q = q_map.get(code)
        axis_cats = _build_axis_cats(df, code, q)
        axis_totals = [int((df[code] == cat).sum()) for cat in axis_cats]
        axis_label = q.question_text if q else code
        return code, axis_cats, axis_totals, axis_label

    if len(group) == 2:
        code_a, code_b = group
        if code_a not in df.columns or code_b not in df.columns:
            return None
        q_a, q_b = q_map.get(code_a), q_map.get(code_b)
        cats_a = _build_axis_cats(df, code_a, q_a)
        cats_b = _build_axis_cats(df, code_b, q_b)
        df["__breakdown_axis__"] = (
            df[code_a].fillna("").astype(str) + _COMPOSITE_SEP + df[code_b].fillna("").astype(str)
        )
        axis_cats = [f"{a}{_COMPOSITE_SEP}{b}" for a in cats_a for b in cats_b]
        axis_totals = [int((df["__breakdown_axis__"] == cat).sum()) for cat in axis_cats]
        label_a = q_a.question_text if q_a else code_a
        label_b = q_b.question_text if q_b else code_b
        return "__breakdown_axis__", axis_cats, axis_totals, f"{label_a}{_COMPOSITE_SEP}{label_b}"

    return None


def _empty_block(block_label: str, axis_code: str, axis_text: str, axis_cats: list[str],
                  axis_totals: list[int], results: list[CrosstabResult],
                  axis_stats: list | None = None) -> Step3SpecialBlock:
    return Step3SpecialBlock(
        block_label=block_label,
        axis_question_code=axis_code,
        axis_question_text=axis_text,
        axis_categories=axis_cats,
        axis_totals=axis_totals,
        results=results,
        warnings=[],
        secondary_axis_question_code="",
        secondary_axis_question_text="",
        primary_axis_categories=[],
        secondary_axis_categories=[],
        axis_stats=axis_stats or [],
    )


# ---------------------------------------------------------------------------
# 1. 属性分析
# ---------------------------------------------------------------------------

@router.post("/step3/special/attribute", response_model=Step3SpecialResponse, summary="特定分析: 属性分析")
async def run_attribute_analysis(body: AttributeAnalysisRequest) -> Step3SpecialResponse:
    df, _questions, q_map, bracket_by_base = _load_session(body.session_token)
    blocks: list[Step3SpecialBlock] = []
    warnings: list[str] = []

    # 単純集計（軸なし全体集計）
    codes = [c for c in body.simple_tally_codes if c in q_map]
    if codes:
        results: list[CrosstabResult] = []
        total_n = len(df)
        for code in codes:
            q = q_map[code]
            tc = q.type_code.upper()
            if tc in _SKIP_TYPES:
                continue
            bcs = bracket_by_base.get(code, [])
            rows, n = _crosstab_total(df, code, q.type_code, bcs)
            total_n = n
            if not rows:
                continue
            results.append(CrosstabResult(
                question_code=code, question_text=q.question_text, type_code=q.type_code, rows=rows,
            ))
        if results:
            blocks.append(_empty_block("単純集計", "", "全体", ["全体"], [total_n], results))

    # クロス集計ペア
    for pair in body.cross_pairs:
        row_q = q_map.get(pair.row_code)
        col_q = q_map.get(pair.col_code)
        if row_q is None or col_q is None:
            warnings.append(f"クロス集計ペア '{pair.row_code} × {pair.col_code}' の設問が見つかりません。")
            continue
        if pair.col_code not in df.columns:
            warnings.append(f"列設問 '{pair.col_code}' がデータに存在しません。")
            continue

        axis_cats = _build_axis_cats(df, pair.col_code, col_q)
        axis_totals = [int((df[pair.col_code] == cat).sum()) for cat in axis_cats]

        tc = row_q.type_code.upper()
        if tc in _CROSSTAB_SA_TYPES:
            if pair.row_code not in df.columns:
                warnings.append(f"行設問 '{pair.row_code}' がデータに存在しません。")
                continue
            rows = _crosstab_sa(df, pair.row_code, pair.col_code, axis_cats, q=row_q)
        elif tc in _CROSSTAB_MA_TYPES:
            bcs = bracket_by_base.get(pair.row_code, [])
            if not bcs:
                warnings.append(f"MA設問 '{pair.row_code}' のbracket列が見つかりませんでした。")
                continue
            rows = _crosstab_ma(df, bcs, pair.col_code, axis_cats)
        else:
            continue

        if not rows:
            continue
        blocks.append(_empty_block(
            f"{row_q.question_text} × {col_q.question_text}",
            pair.col_code, col_q.question_text, axis_cats, axis_totals,
            [CrosstabResult(question_code=pair.row_code, question_text=row_q.question_text,
                             type_code=row_q.type_code, rows=rows)],
        ))

    logger.info("属性分析完了: 単純集計=%d設問, クロス集計=%d組, ブロック数=%d",
                len(codes), len(body.cross_pairs), len(blocks))
    return Step3SpecialResponse(blocks=blocks, warnings=warnings)


# ---------------------------------------------------------------------------
# 2. ファン度分析
# ---------------------------------------------------------------------------
#
# 新ファン度（好意度×応援意向）と旧ファン度（好意度×ファンステージ）は設問形式が
# 異なるため、それぞれの設問自動検出・初期マトリクス作成はフロントエンド（JS）側で
# 行う。バックエンドは「行×列の判定マトリクス（FanDegreeMatrixCell配列）を受け取り、
# 回答者ごとに該当セルを引いてfan_degree_labelを付与し、集計する」処理のみを担う
# 新旧共通の汎用エンジンとして実装する。

_FAN_RANK_LABELS = ["コアファン", "ファン", "ライトファン", "未ファン", "除外"]
_FAN_ABOVE_FAN = {"コアファン", "ファン"}
_FAN_ABOVE_LIGHT = {"コアファン", "ファン", "ライトファン"}
_UNDETERMINED_LABEL = "判定不能"


def _normalize_fan_label(label: str) -> str:
    """正式なラベルは コアファン/ファン/ライトファン/未ファン/判定不能(/除外) のみ。
    旧仕様の「非ファン」は表記揺れになるため、保存・集計・表示前に必ず「未ファン」へ変換する。
    """
    return "未ファン" if label == "非ファン" else label


def _fan_flags_for_label(label: str) -> tuple[int, int, int, int]:
    """fan_degree_labelから (is_core_fan, is_fan_or_above, is_light_fan_or_above, is_fan_degree_valid) を返す。"""
    return (
        int(label == "コアファン"),
        int(label in _FAN_ABOVE_FAN),
        int(label in _FAN_ABOVE_LIGHT),
        int(label != _UNDETERMINED_LABEL),
    )


def _judge_fan_label(row_val, col_val, lookup: dict[tuple[str, str], str]) -> str:
    row_s = "" if pd.isna(row_val) else str(row_val).strip()
    col_s = "" if pd.isna(col_val) else str(col_val).strip()
    if not row_s or not col_s:
        return _UNDETERMINED_LABEL
    label = lookup.get((row_s, col_s), "")
    return label if label else _UNDETERMINED_LABEL


def _apply_fan_denominator_filter(
    df: pd.DataFrame, label_col: str, mode: str, filter_col: str, filter_values: list[str],
) -> pd.DataFrame:
    """集計の分母モードに応じてdfを絞り込む。"""
    if mode == "valid":
        return df[~df[label_col].isin(["除外", _UNDETERMINED_LABEL])]
    if mode == "excluding_undetermined":
        return df[df[label_col] != _UNDETERMINED_LABEL]
    if mode == "filtered":
        if filter_col and filter_col in df.columns and filter_values:
            return df[df[filter_col].astype(str).isin(filter_values)]
        return df
    return df  # "all"


def _build_fan_summary(full_labels: pd.Series, work_labels: pd.Series, mode: str) -> FanDegreeSummary:
    denom_n = int(work_labels.shape[0])
    vc = work_labels.value_counts()
    present = set(work_labels)
    ordered_labels = [lbl for lbl in _FAN_RANK_LABELS if lbl in present]
    if _UNDETERMINED_LABEL in present:
        ordered_labels.append(_UNDETERMINED_LABEL)

    counts: list[FanDegreeCount] = []
    cum = 0.0
    for label in ordered_labels:
        n = int(vc.get(label, 0))
        pct = _safe_float(n / denom_n * 100) if denom_n > 0 else 0.0
        cum = _safe_float(cum + pct)
        counts.append(FanDegreeCount(label=label, n=n, pct=pct, cum_pct=cum))

    core_n = int((work_labels == "コアファン").sum())
    fan_above_n = int(work_labels.isin(_FAN_ABOVE_FAN).sum())
    light_above_n = int(work_labels.isin(_FAN_ABOVE_LIGHT).sum())

    return FanDegreeSummary(
        counts=counts,
        denominator_n=denom_n,
        denominator_mode=mode,
        core_fan_rate=_safe_float(core_n / denom_n * 100) if denom_n > 0 else 0.0,
        fan_or_above_rate=_safe_float(fan_above_n / denom_n * 100) if denom_n > 0 else 0.0,
        light_fan_or_above_rate=_safe_float(light_above_n / denom_n * 100) if denom_n > 0 else 0.0,
        undetermined_n=int((full_labels == _UNDETERMINED_LABEL).sum()),
        excluded_n=int((full_labels == "除外").sum()),
    )


@router.post("/step3/special/fan", response_model=FanAnalysisResponse, summary="特定分析: ファン度分析")
async def run_fan_analysis(body: FanAnalysisRequest) -> FanAnalysisResponse:
    df, _questions, q_map, _bracket_by_base = _load_session(body.session_token)
    warnings: list[str] = []

    if body.row_question_code not in df.columns:
        raise HTTPException(422, f"縦軸設問 '{body.row_question_code}' がデータに存在しません。")
    if body.col_question_code not in df.columns:
        raise HTTPException(422, f"横軸設問 '{body.col_question_code}' がデータに存在しません。")

    row_q = q_map.get(body.row_question_code)
    col_q = q_map.get(body.col_question_code)
    row_cats = _build_axis_cats(df, body.row_question_code, row_q)
    col_cats = _build_axis_cats(df, body.col_question_code, col_q)

    normalized_matrix = [
        FanDegreeMatrixCell(row_value=c.row_value, col_value=c.col_value, label=_normalize_fan_label(c.label))
        for c in body.matrix
    ]
    lookup = {(c.row_value, c.col_value): c.label for c in normalized_matrix if c.label}

    label_series = [
        _judge_fan_label(r, c, lookup)
        for r, c in zip(df[body.row_question_code], df[body.col_question_code])
    ]
    df["__fan_label__"] = label_series

    work_df = _apply_fan_denominator_filter(
        df, "__fan_label__", body.denominator_mode, body.target_filter_column, body.target_filter_values,
    )
    summary = _build_fan_summary(df["__fan_label__"], work_df["__fan_label__"], body.denominator_mode)

    blocks: list[Step3SpecialBlock] = []

    overall_rows, overall_n = _crosstab_total(work_df, "__fan_label__", "SA", [])
    if overall_rows:
        blocks.append(_empty_block(
            "ファン度集計（全体）", "", "全体", ["全体"], [overall_n],
            [CrosstabResult(question_code="__fan_label__", question_text="ファン度", type_code="SA", rows=overall_rows)],
        ))

    row_answers = df[body.row_question_code].fillna("").astype(str)
    col_answers = df[body.col_question_code].fillna("").astype(str)
    respondent_rows = []
    for rid, (ra, ca, lbl) in enumerate(zip(row_answers, col_answers, label_series), start=1):
        core, above, light, valid = _fan_flags_for_label(lbl)
        respondent_rows.append(FanDegreeRespondentRow(
            response_id=rid, row_answer=ra, col_answer=ca, fan_degree_label=lbl,
            status=_UNDETERMINED_LABEL if lbl == _UNDETERMINED_LABEL else "判定済",
            is_core_fan=core, is_fan_or_above=above, is_light_fan_or_above=light, is_fan_degree_valid=valid,
        ))

    logger.info(
        "ファン度分析完了: type=%s, 判定不能=%d, 除外=%d",
        body.fan_degree_type, summary.undetermined_n, summary.excluded_n,
    )
    return FanAnalysisResponse(
        blocks=blocks, warnings=warnings, summary=summary, matrix=normalized_matrix,
        row_question_code=body.row_question_code,
        row_question_text=row_q.question_text if row_q else body.row_question_code,
        col_question_code=body.col_question_code,
        col_question_text=col_q.question_text if col_q else body.col_question_code,
        row_categories=row_cats, col_categories=col_cats, respondent_rows=respondent_rows,
    )


# ---------------------------------------------------------------------------
# 2-b. ファン度分析: 判定結果を通常分析用の派生属性として保存する
# ---------------------------------------------------------------------------
# ファン度分析画面は判定のみに専念し、属性別の内訳は通常分析側で
# fan_degree_label を集計軸として使うことで実現する設計。そのため、判定結果
# （fan_degree_label / is_core_fan / is_fan_or_above / is_light_fan_or_above /
# is_fan_degree_valid）を response_id（データフレームの行位置、匿名の行番号で
# あり個人情報ではない）の順序を保ったまま labeled_parquet に新規列として
# 書き込む。以後は通常分析の集計軸・クロス集計・フィルタ・平均点分析の集計軸
# などから、他のSA設問と全く同じ方法で参照できる（クロス集計エンジン自体は
# 無改修）。新旧/カスタムが共存できるよう、列名には fan_degree_type を含める。

_FAN_TYPE_SUFFIX = {"new": "新", "old": "旧", "custom": "カスタム"}
_FAN_TYPE_ROW_BASE = {"new": 100_000, "old": 100_010, "custom": 100_020}
_FAN_LABEL_CHOICES = ["コアファン", "ファン", "ライトファン", "未ファン", _UNDETERMINED_LABEL]
_FAN_FLAG_CHOICES = ["1", "0"]


def _fan_axis_column_names(fan_degree_type: str) -> dict[str, str]:
    return {
        "label": f"__fan_degree_label_{fan_degree_type}__",
        "core": f"__fan_is_core_fan_{fan_degree_type}__",
        "above": f"__fan_is_fan_or_above_{fan_degree_type}__",
        "light": f"__fan_is_light_fan_or_above_{fan_degree_type}__",
        "valid": f"__fan_is_fan_degree_valid_{fan_degree_type}__",
    }


def _fan_axis_question(code: str, text: str, choices: list[str], row_index: int) -> QuestionItem:
    return QuestionItem(
        question_code=code, type_code="SA", type_label="SA",
        question_text=text, stub=text,
        choices=[ChoiceItem(choice_index=i, choice_text=c) for i, c in enumerate(choices)],
        row_index=row_index, original_question="", original_type="SA",
        question_type="DERIVED", auto_detected_type="DERIVED",
    )


@router.post(
    "/step3/special/fan/save-as-axis", response_model=FanDegreeSaveResponse,
    summary="特定分析: ファン度判定結果を通常分析用の派生属性として保存",
)
async def save_fan_degree_as_axis(body: FanDegreeSaveRequest) -> FanDegreeSaveResponse:
    df, questions, _q_map, _bracket_by_base = _load_session(body.session_token)

    if body.row_question_code not in df.columns:
        raise HTTPException(422, f"縦軸設問 '{body.row_question_code}' がデータに存在しません。")
    if body.col_question_code not in df.columns:
        raise HTTPException(422, f"横軸設問 '{body.col_question_code}' がデータに存在しません。")

    step2_data = survey_cache.get_step2(body.session_token)
    saved_registry: dict[str, dict] = dict(step2_data.get("fan_degree_saved", {}))
    overwritten = body.fan_degree_type in saved_registry
    if overwritten and not body.overwrite:
        raise HTTPException(409, "既にファン度の判定結果が保存されています。上書きしますか？")

    lookup = {
        (c.row_value, c.col_value): _normalize_fan_label(c.label)
        for c in body.matrix if c.label
    }
    label_series = [
        _judge_fan_label(r, c, lookup)
        for r, c in zip(df[body.row_question_code], df[body.col_question_code])
    ]

    cols = _fan_axis_column_names(body.fan_degree_type)
    core_list: list[str] = []
    above_list: list[str] = []
    light_list: list[str] = []
    valid_list: list[str] = []
    for lbl in label_series:
        core, above, light, valid = _fan_flags_for_label(lbl)
        core_list.append(str(core))
        above_list.append(str(above))
        light_list.append(str(light))
        valid_list.append(str(valid))

    df[cols["label"]] = label_series
    df[cols["core"]] = core_list
    df[cols["above"]] = above_list
    df[cols["light"]] = light_list
    df[cols["valid"]] = valid_list

    new_path = save_parquet(body.session_token, df, "labeled_data")
    step2_data["labeled_parquet_path"] = str(new_path)
    saved_registry[body.fan_degree_type] = {
        "row_question_code": body.row_question_code,
        "col_question_code": body.col_question_code,
        "saved_at": datetime.now().isoformat(),
    }
    step2_data["fan_degree_saved"] = saved_registry
    # _resolve_needed_columns（step3.py）は target_question_codes/target_filter_column が
    # matched_columns に含まれる列のみ列プロジェクション対象にする。派生列もここに登録しないと
    # 通常分析のクロス集計・フィルタで（target_question_codesを指定した場合に）読み込まれない。
    matched = set(step2_data.get("matched_columns", []))
    matched.update(cols.values())
    step2_data["matched_columns"] = list(matched)
    survey_cache.set_step2(body.session_token, step2_data)

    suffix = _FAN_TYPE_SUFFIX.get(body.fan_degree_type, body.fan_degree_type)
    base_row_index = _FAN_TYPE_ROW_BASE.get(body.fan_degree_type, 100_030)
    new_questions = [
        _fan_axis_question(cols["label"], f"ファン度（{suffix}）", _FAN_LABEL_CHOICES, base_row_index),
        _fan_axis_question(cols["core"], f"コアファンフラグ（{suffix}）", _FAN_FLAG_CHOICES, base_row_index + 1),
        _fan_axis_question(cols["above"], f"ファン以上フラグ（{suffix}）", _FAN_FLAG_CHOICES, base_row_index + 2),
        _fan_axis_question(cols["light"], f"ライトファン以上フラグ（{suffix}）", _FAN_FLAG_CHOICES, base_row_index + 3),
        _fan_axis_question(cols["valid"], f"ファン度判定可否（{suffix}）", _FAN_FLAG_CHOICES, base_row_index + 4),
    ]
    new_codes = {q.question_code for q in new_questions}
    updated_questions = [q for q in questions if q.question_code not in new_codes] + new_questions
    survey_cache.set(body.session_token, updated_questions, survey_cache.get_meta(body.session_token))

    logger.info(
        "ファン度派生属性保存: type=%s, 上書き=%s, 列=%s", body.fan_degree_type, overwritten, list(cols.values()),
    )
    return FanDegreeSaveResponse(
        message="ファン度を通常分析で使える軸として保存しました。通常分析の集計軸・フィルタで選択できます。",
        overwritten=overwritten,
        axis_questions=new_questions,
    )


# ---------------------------------------------------------------------------
# 3. 平均点分析
# ---------------------------------------------------------------------------
#
# 「元の回答尺度」(input_min/max_score) と「分析時の表示尺度」(output_min/max_score) を
# 分離して管理する。選択肢ごとの実際の得点（final_score）はフロント側で
# 自動抽出（選択肢ラベル先頭の数値）→ 線形換算 → 手動上書き、の順で確定し、
# choice_scores としてそのまま送られてくる。バックエンドは final_score を
# 信頼してデータへ適用し、統計量を算出する（除外/欠損フラグの選択肢は集計対象外）。

def _compute_axis_stat(category: str, scores: "pd.Series", n_total: int) -> AverageAxisStat:
    valid = scores.dropna()
    n_valid = int(valid.shape[0])
    n_excluded = max(int(n_total) - n_valid, 0)
    if n_valid == 0:
        return AverageAxisStat(category=category, n_valid=0, n_excluded=n_excluded)
    return AverageAxisStat(
        category=category,
        n_valid=n_valid,
        n_excluded=n_excluded,
        mean=_safe_float(valid.mean()),
        std=_safe_float(valid.std()) if n_valid > 1 else 0.0,
        median=_safe_float(valid.median()),
        min=_safe_float(valid.min()),
        max=_safe_float(valid.max()),
    )


@router.post("/step3/special/average", response_model=Step3SpecialResponse, summary="特定分析: 平均点分析")
async def run_average_analysis(body: AverageAnalysisRequest) -> Step3SpecialResponse:
    df, _questions, q_map, bracket_by_base = _load_session(body.session_token)
    warnings: list[str] = []
    blocks: list[Step3SpecialBlock] = []

    for target in body.targets:
        code = target.question_code
        q = q_map.get(code)
        if q is None or code not in df.columns:
            warnings.append(f"設問 '{code}' がデータに存在しません。")
            continue
        theme = q.question_text

        # 除外/欠損フラグの選択肢は score_map から外す → map結果がNaNになり集計対象外になる
        score_map: dict[str, float] = {
            entry.choice_text: entry.final_score
            for entry in target.choice_scores
            if not entry.exclude_flag and not entry.missing_flag and entry.final_score is not None
        }
        score_col = f"__score_{code}__"
        df[score_col] = df[code].astype(str).map(score_map)

        # 全体ブロック（選択肢別の分布 + 統計量）
        dist_rows, total_n = _crosstab_total(df, code, q.type_code, bracket_by_base.get(code, []))
        overall_stat = _compute_axis_stat("全体", df[score_col], total_n)
        if dist_rows:
            blocks.append(_empty_block(
                f"{theme}：全体", "", "全体", ["全体"], [total_n],
                [CrosstabResult(question_code=code, question_text=theme, type_code=q.type_code, rows=dist_rows)],
                axis_stats=[overall_stat],
            ))

    logger.info("平均点分析完了: 対象設問数=%d, ブロック数=%d", len(body.targets), len(blocks))
    return Step3SpecialResponse(blocks=blocks, warnings=warnings)


# ---------------------------------------------------------------------------
# 3-b. 平均点分析: スコアを通常分析用の数値指標として保存する
# ---------------------------------------------------------------------------

def _compute_respondent_scores(df: pd.DataFrame, code: str, choice_scores: list) -> pd.Series:
    """選択肢スコアマッピングを使い、回答者ごとの数値スコアを返す。"""
    score_map: dict[str, float] = {
        entry.choice_text: entry.final_score
        for entry in choice_scores
        if not entry.exclude_flag and not entry.missing_flag and entry.final_score is not None
    }
    return df[code].astype(str).map(score_map).astype(float)


@router.post(
    "/step3/special/average/save-as-indicator",
    response_model=AverageSaveAsIndicatorResponse,
    summary="特定分析: 平均点指標を通常分析用の数値指標として保存",
)
async def save_average_as_indicator(body: AverageSaveAsIndicatorRequest) -> AverageSaveAsIndicatorResponse:
    df, questions, q_map, _ = _load_session(body.session_token)

    code = body.question_code
    q = q_map.get(code)
    if q is None or code not in df.columns:
        raise HTTPException(422, f"設問 '{code}' がデータに存在しません。")

    saved_col = f"__avg_score_{code}__"
    step2_data = survey_cache.get_step2(body.session_token)
    matched = set(step2_data.get("matched_columns", []))

    if saved_col in matched and not body.overwrite:
        raise HTTPException(409, f"指標 '{body.indicator_name}' は既に保存されています。上書きしますか？")

    df[saved_col] = _compute_respondent_scores(df, code, body.choice_scores)

    new_path = save_parquet(body.session_token, df, "labeled_data")
    step2_data["labeled_parquet_path"] = str(new_path)
    matched.add(saved_col)
    step2_data["matched_columns"] = list(matched)
    survey_cache.set_step2(body.session_token, step2_data)

    indicator_q = QuestionItem(
        question_code=saved_col,
        type_code="NU",
        type_label="NU",
        question_text=body.indicator_name,
        stub=body.indicator_name,
        choices=[],
        row_index=101_000 + (abs(hash(code)) % 1000),
        original_question="",
        original_type="NU",
        question_type="SCORE",
        auto_detected_type="SCORE",
    )

    new_codes = {indicator_q.question_code}
    updated_questions = [q for q in questions if q.question_code not in new_codes] + [indicator_q]
    survey_cache.set(body.session_token, updated_questions, survey_cache.get_meta(body.session_token))

    logger.info("平均点指標保存: %s → %s, 表示名=%s", code, saved_col, body.indicator_name)
    return AverageSaveAsIndicatorResponse(indicator_question=indicator_q, saved_column=saved_col)


# ---------------------------------------------------------------------------
# 1-b. 属性分析: クロスペアを通常分析用の派生軸として保存する
# ---------------------------------------------------------------------------

@router.post(
    "/step3/special/attribute/save-as-axis",
    response_model=AttributeSaveAsAxisResponse,
    summary="特定分析: 属性軸を通常分析用の派生軸として保存",
)
async def save_attribute_as_axis(body: AttributeSaveAsAxisRequest) -> AttributeSaveAsAxisResponse:
    df, questions, q_map, _ = _load_session(body.session_token)

    if body.row_code not in df.columns:
        raise HTTPException(422, f"行設問 '{body.row_code}' がデータに存在しません。")
    if body.col_code not in df.columns:
        raise HTTPException(422, f"列設問 '{body.col_code}' がデータに存在しません。")

    saved_col = f"__attr_{body.row_code}_{body.col_code}__"
    step2_data = survey_cache.get_step2(body.session_token)
    matched = set(step2_data.get("matched_columns", []))

    if saved_col in matched and not body.overwrite:
        raise HTTPException(409, f"軸 '{body.axis_name}' は既に保存されています。上書きしますか？")

    if body.row_code != body.col_code:
        combined = df[body.row_code].fillna("").astype(str) + "×" + df[body.col_code].fillna("").astype(str)
    else:
        combined = df[body.row_code].fillna("").astype(str)
    df[saved_col] = combined

    new_path = save_parquet(body.session_token, df, "labeled_data")
    step2_data["labeled_parquet_path"] = str(new_path)
    matched.add(saved_col)
    step2_data["matched_columns"] = list(matched)
    survey_cache.set_step2(body.session_token, step2_data)

    unique_vals = sorted(combined.dropna().unique().tolist())
    choices = [ChoiceItem(choice_index=i, choice_text=str(v)) for i, v in enumerate(unique_vals)]

    axis_q = QuestionItem(
        question_code=saved_col,
        type_code="SA",
        type_label="SA",
        question_text=body.axis_name,
        stub=body.axis_name,
        choices=choices,
        row_index=102_000 + (abs(hash(saved_col)) % 1000),
        original_question="",
        original_type="SA",
        question_type="DERIVED",
        auto_detected_type="DERIVED",
    )

    new_codes = {axis_q.question_code}
    updated_questions = [q for q in questions if q.question_code not in new_codes] + [axis_q]
    survey_cache.set(body.session_token, updated_questions, survey_cache.get_meta(body.session_token))

    logger.info("属性軸保存: %s × %s → %s, 表示名=%s", body.row_code, body.col_code, saved_col, body.axis_name)
    return AttributeSaveAsAxisResponse(axis_questions=[axis_q], saved_column=saved_col)


# ---------------------------------------------------------------------------
# 4. ファン度分析: Excelエクスポート
# ---------------------------------------------------------------------------
# 集計をやり直さず、フロントエンドが保持している直前の分析結果（FanAnalysisResponse）
# をそのままシート化する（既存のStep3ExportRequestと同じ設計方針）。

def _safe_export_filename(name: str) -> str:
    return f"UTF-8''{quote(name, safe='')}"


@router.post("/step3/special/fan/export", summary="特定分析: ファン度分析結果をExcel出力")
async def export_fan_analysis(body: FanAnalysisResponse) -> StreamingResponse:
    buf = build_fan_excel_workbook(body)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"fan_degree_{ts}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{filename}\"; filename*={_safe_export_filename(filename)}"
            )
        },
    )

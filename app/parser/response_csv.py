"""回答データ CSV / xlsx の解析・ラベル変換ロジック。"""

from __future__ import annotations

import io
import logging
import re
from collections import defaultdict
from typing import List, Optional

import pandas as pd

from app.schemas import AxisCandidateItem, QuestionItem
from app.utils import detect_encoding

logger = logging.getLogger(__name__)

AXIS_CANDIDATE_TYPES = {"SA", "S", "NU", "N", "ML"}
MULTI_SELECT_TYPES = {"MA", "ML"}
_FA_TYPES = {"FA", "F"}
_SPECIAL_TYPES = {"X", "XL", "SL"}

BRACKET_RE = re.compile(r"^(.+)\[(\d+)\]$")


def _parse_bracket(col: str) -> Optional[tuple[str, int]]:
    """Q3_1[1] → ("Q3_1", 1)、非ブラケット列は None を返す。"""
    m = BRACKET_RE.match(col)
    return (m.group(1), int(m.group(2))) if m else None

PREVIEW_ROWS = 5
MAX_ROWS_IN_MEMORY = 50_000


def parse_response_file(raw_bytes: bytes, filename: str) -> tuple[pd.DataFrame, str]:
    """CSV (Shift-JIS / UTF-8 自動判定) または xlsx を解析して DataFrame を返す。"""
    name_lower = filename.lower()
    if name_lower.endswith(".xlsx") or name_lower.endswith(".xls"):
        engine = "openpyxl" if name_lower.endswith(".xlsx") else "xlrd"
        df = pd.read_excel(io.BytesIO(raw_bytes), engine=engine, dtype=str)
        df = df.fillna("")
        encoding_label = "Excel"
        logger.info("Excel ファイル解析完了: %d 行 %d 列", len(df), len(df.columns))
        return df, encoding_label

    encoding = detect_encoding(raw_bytes)
    df = _read_csv_bytes(raw_bytes, encoding)
    logger.info("CSV 解析完了 (encoding=%s): %d 行 %d 列", encoding, len(df), len(df.columns))
    return df, encoding


def _read_csv_bytes(raw_bytes: bytes, encoding: str) -> pd.DataFrame:
    fallback_chain = [encoding, "utf-8", "cp932", "shift_jis_2004", "euc-jp"]
    seen: set[str] = set()
    last_exc: Optional[Exception] = None
    for enc in fallback_chain:
        if enc in seen:
            continue
        seen.add(enc)
        try:
            text = raw_bytes.decode(enc, errors="replace")
            df = pd.read_csv(io.StringIO(text), dtype=str).fillna("")
            return df
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    raise ValueError(f"CSV を読み込めませんでした: {last_exc}")


def build_codebook(questions: List[QuestionItem]) -> dict:
    """
    QuestionItem.choices から変換辞書を構築する。

    返り値: {question_code: {str(choice_index): choice_text}}
    変換辞書は必ず Question 単位で作成し、全設問共通辞書は作らない。
    """
    codebook: dict = {}
    for q in questions:
        if not q.choices:
            continue
        codebook[q.question_code] = {
            str(c.choice_index): c.choice_text for c in q.choices
        }
    return codebook


def match_columns(
    df_cols: List[str],
    layout_codes: List[str],
    questions: Optional[List[QuestionItem]] = None,
) -> tuple[List[str], List[str], List[str], List[dict]]:
    """
    回答データ列名とレイアウト設問コードを照合する。

    ブラケット記法列（Q3_1[1]）は親コード（Q3_1）配下の選択肢列として認識し、
    extra / missing の対象から除外する。

    Returns:
        matched:        一致列（完全一致 + ブラケットで補完された親コード）
        missing:        レイアウトにあるが回答データにない列
        extra:          回答データにだけある列（ブラケット列を除く）
        bracket_cols:   ブラケット列の詳細リスト
    """
    response_set = set(df_cols)
    layout_set = set(layout_codes)
    question_map = {q.question_code: q for q in (questions or [])}

    bracket_cols: List[dict] = []
    bracket_base_codes: set[str] = set()
    bracket_col_names: set[str] = set()

    for col in df_cols:
        parsed = _parse_bracket(col)
        if not parsed:
            continue
        base_code, choice_no = parsed
        if base_code not in layout_set:
            continue

        q = question_map.get(base_code)
        choice_label = ""
        if q:
            for c in q.choices:
                if c.choice_index == choice_no:
                    choice_label = c.choice_text
                    break
        display_header = f"{base_code}：{choice_label}" if choice_label else col

        bracket_cols.append({
            "column_name": col,
            "base_code": base_code,
            "choice_no": choice_no,
            "choice_label": choice_label,
            "display_header": display_header,
        })
        bracket_base_codes.add(base_code)
        bracket_col_names.add(col)

    matched = sorted((response_set & layout_set) | bracket_base_codes)
    missing = sorted(layout_set - response_set - bracket_base_codes)
    extra = sorted(response_set - layout_set - bracket_col_names)
    bracket_cols_sorted = sorted(bracket_cols, key=lambda b: (b["base_code"], b["choice_no"]))
    return matched, missing, extra, bracket_cols_sorted


def _normalize_key(v: str) -> str:
    """1.0 → "1" のように浮動小数点表記を整数文字列に正規化する。"""
    try:
        f = float(v)
        if f == int(f):
            return str(int(f))
    except (ValueError, OverflowError):
        pass
    return v


def convert_labels(
    df: pd.DataFrame,
    codebook: dict,
    matched_columns: List[str],
    bracket_columns: Optional[List[dict]] = None,
) -> tuple[pd.DataFrame, List[dict]]:
    """
    回答データの値を変換辞書に基づいてラベルに変換する。

    - raw_data は変更しない（df をコピーして labeled_df を返す）
    - 変換キーは _normalize_key() で正規化
    - 辞書にない値は元値のまま保持し unmatched_values に記録
    - ブラケット列（Q3_1[1]）は 0/1 → 選択なし/選択あり に変換し、
      列名を display_header（例: Q3_1：TV・ラジオ…）にリネームする

    Returns:
        labeled_df:       変換後 DataFrame
        unmatched_values: [{question_code, value, count}]
    """
    labeled_df = df.copy()
    unmatched_values: List[dict] = []

    for col in matched_columns:
        if col not in df.columns:
            continue
        col_dict = codebook.get(col)
        if not col_dict:
            continue

        unmatched_counter: dict[str, int] = defaultdict(int)

        def _convert(v: str, _d=col_dict, _c=unmatched_counter) -> str:
            if v == "" or v is None:
                return v
            key = _normalize_key(str(v))
            if key in _d:
                return _d[key]
            _c[key] += 1
            return v

        labeled_df[col] = df[col].apply(_convert)

        for val, count in unmatched_counter.items():
            unmatched_values.append(
                {"question_code": col, "value": val, "count": count}
            )

    for bc in (bracket_columns or []):
        col = bc["column_name"]
        if col not in df.columns:
            continue

        def _convert_binary(v: str) -> str:
            key = _normalize_key(str(v))
            if v == "" or key == "0":
                return "選択なし"
            if key == "1":
                return "選択あり"
            return v

        labeled_df[col] = df[col].apply(_convert_binary)

    if bracket_columns:
        rename_map = {bc["column_name"]: bc["display_header"] for bc in bracket_columns}
        labeled_df = labeled_df.rename(columns=rename_map)

    return labeled_df, unmatched_values


def detect_multi_select(
    df: pd.DataFrame, questions: List[QuestionItem], matched_columns: List[str]
) -> List[str]:
    """
    複数選択設問を検出する。

    - type_code が MA / ML の列
    - 値にカンマを含む列（1,3,5 形式）
    """
    multi_type_codes = {q.question_code for q in questions if q.type_code.upper() in MULTI_SELECT_TYPES}
    result: List[str] = []
    for col in matched_columns:
        if col not in df.columns:
            continue
        if col in multi_type_codes:
            result.append(col)
            continue
        sample = df[col].dropna().head(50)
        if sample.astype(str).str.contains(",").any():
            result.append(col)
    return sorted(result)


def build_axis_candidates(
    questions: List[QuestionItem], matched_columns: List[str]
) -> List[AxisCandidateItem]:
    """
    集計軸候補を構築する。

    - matched_columns に含まれる設問のみ対象
    - SA / NU / ML 系は is_default_selected=True
    - MA / FA 系は is_default_selected=False
    """
    matched_set = set(matched_columns)
    candidates: List[AxisCandidateItem] = []
    for q in questions:
        if q.question_code not in matched_set:
            continue
        is_default = q.type_code.upper() in AXIS_CANDIDATE_TYPES
        candidates.append(
            AxisCandidateItem(
                question_code=q.question_code,
                question_text=q.question_text,
                type_code=q.type_code,
                type_label=q.type_label,
                is_default_selected=is_default,
            )
        )
    return candidates


def classify_missing_columns(
    missing: List[str],
    questions: List[QuestionItem],
    matched: List[str],
    bracket_cols: List[dict],
) -> List[dict]:
    """
    不足列（missing）をSTEP1の設問構造を使って分類する。

    verdict 値:
        "parent_matched"   : 子設問が直接照合済みの親設問（回答不要）
        "bracket_expanded" : 子設問がブラケット展開列として照合済みの親設問
        "free_answer"      : 自由回答型の設問（別列名の可能性あり）
        "need_check"       : 特殊種別・子なし照合不可（要確認）
        "unmatched"        : 対応列なし（未照合）
    """
    question_map = {q.question_code: q for q in questions}
    matched_set = set(matched)

    children_map: dict[str, list[str]] = defaultdict(list)
    for q in questions:
        if q.parent_code:
            children_map[q.parent_code].append(q.question_code)

    return [
        _classify_one(code, question_map, children_map, matched_set, bracket_cols)
        for code in missing
    ]


def _classify_one(
    code: str,
    question_map: dict,
    children_map: dict,
    matched_set: set,
    bracket_cols: List[dict],
) -> dict:
    q = question_map.get(code)
    if q is None:
        return {
            "question_code": code,
            "type_code": "", "type_label": "", "question_text": "", "stub": "",
            "verdict": "unmatched",
            "verdict_label": "未照合",
            "reason": "レイアウト情報が見つかりません",
            "related_response_cols": [],
        }

    base = {
        "question_code": q.question_code,
        "type_code": q.type_code,
        "type_label": q.type_label,
        "question_text": q.question_text,
        "stub": q.stub,
    }

    children_codes = set(children_map.get(code, []))
    children_matched = children_codes & matched_set
    child_bracket_items = [bc for bc in bracket_cols if bc["base_code"] in children_codes]

    if children_codes:  # 親設問
        if child_bracket_items:
            col_names = sorted({bc["column_name"] for bc in child_bracket_items})
            first, last = col_names[0], col_names[-1]
            reason = (
                f"親設問のため、回答データには {first}〜{last} のような展開列として存在します"
            )
            return {**base,
                "verdict": "bracket_expanded",
                "verdict_label": "展開列として照合済み",
                "reason": reason,
                "related_response_cols": col_names[:20],
            }
        elif children_matched:
            child_list = "、".join(sorted(children_matched)[:5])
            if len(children_matched) > 5:
                child_list += f"（他 {len(children_matched) - 5} 件）"
            reason = f"親設問のため、回答データには子設問（{child_list}）として存在します"
            return {**base,
                "verdict": "parent_matched",
                "verdict_label": "回答不要の親設問",
                "reason": reason,
                "related_response_cols": sorted(children_matched),
            }
        else:
            tc = q.type_code.upper()
            if tc in _SPECIAL_TYPES:
                reason = f"特殊種別（{q.type_label}）の親設問です。子設問が回答データに見つかりません"
            elif tc in _FA_TYPES:
                reason = f"自由回答（{q.type_label}）の親設問です。子設問が回答データに見つかりません"
            else:
                reason = "子設問が回答データに見つかりません"
            return {**base,
                "verdict": "need_check",
                "verdict_label": "要確認",
                "reason": reason,
                "related_response_cols": [],
            }
    else:  # 子のない設問（葉ノード）
        tc = q.type_code.upper()
        if tc in _FA_TYPES:
            return {**base,
                "verdict": "free_answer",
                "verdict_label": "要確認（自由回答）",
                "reason": (
                    f"自由回答項目（{q.type_label}）です。"
                    "回答データ側では別の列名で存在する可能性があります"
                ),
                "related_response_cols": [],
            }
        if tc in _SPECIAL_TYPES:
            return {**base,
                "verdict": "need_check",
                "verdict_label": "要確認（特殊種別）",
                "reason": (
                    f"特殊種別（{q.type_label}）です。"
                    "回答データ側では別の形式や列名で存在する可能性があります"
                ),
                "related_response_cols": [],
            }
        if q.is_child and q.parent_code and q.parent_code in matched_set:
            return {**base,
                "verdict": "need_check",
                "verdict_label": "要確認",
                "reason": (
                    f"親設問（{q.parent_code}）は照合済みですが、"
                    "この子設問は回答データに見つかりません"
                ),
                "related_response_cols": [q.parent_code],
            }
        return {**base,
            "verdict": "unmatched",
            "verdict_label": "未照合",
            "reason": "回答データに対応する列が見つかりません",
            "related_response_cols": [],
        }


_FA_BROWSE_TYPES = {"FA", "F", "OA"}

_KEY_COLUMN_PATTERNS = {"key", "id", "no.", "no", "番号", "サンプルid", "回答id", "回答no", "サンプルno"}


def _detect_key_column(df: "pd.DataFrame") -> str:
    for col in df.columns:
        if col.lower() in _KEY_COLUMN_PATTERNS:
            return col
    return ""


def _build_attr_candidates(
    axis_candidates: List[AxisCandidateItem],
    selected_axis_columns: List[str],
) -> List[dict]:
    """FaAttrCandidate dict リストを生成し、集計軸選択済み → ファン度 → その他 の順でソートする。"""
    fan_set = {
        c.question_code for c in axis_candidates
        if "ファン度" in c.question_text or "ファン度" in c.question_code
    }
    selected_set = set(selected_axis_columns)
    candidates = [
        {
            "question_code": c.question_code,
            "question_text": c.question_text,
            "type_label": c.type_label,
            "is_fan_do": c.question_code in fan_set,
            "is_axis_selected": c.question_code in selected_set,
        }
        for c in axis_candidates
    ]
    candidates.sort(key=lambda x: (0 if x["is_axis_selected"] else 1, 0 if x["is_fan_do"] else 1))
    return candidates


def build_fa_meta(
    questions: List[QuestionItem],
    labeled_data: dict,
    matched_columns: List[str],
    axis_candidates: List[AxisCandidateItem],
    selected_axis_columns: List[str],
) -> dict:
    """行データを生成せずメタ情報のみ返す（FA選択 UI の初期化用）。"""
    matched_set = set(matched_columns)
    fa_questions = [
        q for q in questions
        if q.type_code.upper() in _FA_BROWSE_TYPES and q.question_code in matched_set
    ]
    fa_columns_info = [
        {
            "question_code": q.question_code,
            "question_text": q.question_text,
            "type_code": q.type_code,
            "type_label": q.type_label,
        }
        for q in fa_questions
    ]
    attr_candidates = _build_attr_candidates(axis_candidates, selected_axis_columns)
    df = pd.DataFrame(labeled_data) if labeled_data else pd.DataFrame()
    key_col = _detect_key_column(df) if not df.empty else ""
    return {
        "fa_columns": fa_columns_info,
        "attr_candidates": attr_candidates,
        "key_column_name": key_col,
    }


def build_fa_data(
    questions: List[QuestionItem],
    labeled_data: dict,
    matched_columns: List[str],
    axis_candidates: List[AxisCandidateItem],
    selected_axis_columns: List[str],
    attr_columns: List[str],
    exclude_empty: bool,
    min_chars: int,
    sort_by: str,
    sort_attr: str,
    fa_codes: List[str],
    keyword: str = "",
) -> dict:
    """FA閲覧用データを構築する。各FA列 × 全行 を縦持ちに変換し、フィルタ・ソートを適用して返す。"""
    matched_set = set(matched_columns)
    fa_questions = [
        q for q in questions
        if q.type_code.upper() in _FA_BROWSE_TYPES and q.question_code in matched_set
    ]

    fa_columns_info = [
        {
            "question_code": q.question_code,
            "question_text": q.question_text,
            "type_code": q.type_code,
            "type_label": q.type_label,
        }
        for q in fa_questions
    ]

    attr_candidates = _build_attr_candidates(axis_candidates, selected_axis_columns)

    if not fa_questions or not labeled_data:
        return {
            "fa_columns": fa_columns_info,
            "attr_candidates": attr_candidates,
            "key_column_name": "",
            "total_fa_rows": 0,
            "filtered_row_count": 0,
            "rows": [],
        }

    df = pd.DataFrame(labeled_data)
    key_col = _detect_key_column(df)
    fa_filter_set = set(fa_codes) if fa_codes else None
    valid_attr_cols = [c for c in attr_columns if c in df.columns]

    rows: List[dict] = []
    for q in fa_questions:
        if fa_filter_set and q.question_code not in fa_filter_set:
            continue
        if q.question_code not in df.columns:
            continue
        for idx, answer in enumerate(df[q.question_code]):
            answer_str = str(answer) if answer is not None else ""
            is_empty = (answer_str == "")
            rows.append({
                "row_index": idx,
                "is_empty": is_empty,
                "key_value": str(df[key_col].iloc[idx]) if key_col else "",
                "attr_values": {c: str(df[c].iloc[idx]) for c in valid_attr_cols},
                "question_code": q.question_code,
                "question_text": q.question_text,
                "type_code": q.type_code,
                "type_label": q.type_label,
                "answer": answer_str,
                "char_count": len(answer_str),
            })

    total_fa_rows = len(rows)
    empty_row_count = sum(1 for r in rows if r["is_empty"])

    # 空行は min_chars / keyword フィルタの対象外（is_empty 行は除外しない）
    if min_chars > 0:
        rows = [r for r in rows if r["is_empty"] or r["char_count"] >= min_chars]
    if keyword:
        kw = keyword.lower()
        rows = [r for r in rows if r["is_empty"] or kw in r["answer"].lower()]

    # filtered_row_count = 空行を除いた有効行数
    filtered_row_count = sum(1 for r in rows if not r["is_empty"])

    # ソート: タプルキーで空行を末尾に
    if sort_by == "chars_desc":
        rows.sort(key=lambda r: (r["is_empty"], -r["char_count"]))
    elif sort_by == "chars_asc":
        rows.sort(key=lambda r: (r["is_empty"], r["char_count"]))
    elif sort_by == "attr_order" and sort_attr and sort_attr in valid_attr_cols:
        rows.sort(key=lambda r: (r["is_empty"], r["attr_values"].get(sort_attr, "")))

    return {
        "fa_columns": fa_columns_info,
        "attr_candidates": attr_candidates,
        "key_column_name": key_col,
        "total_fa_rows": total_fa_rows,
        "filtered_row_count": filtered_row_count,
        "empty_row_count": empty_row_count,
        "rows": rows,
    }


def df_to_serializable(df: pd.DataFrame) -> dict:
    """DataFrame を JSON シリアライズ可能な dict に変換する。"""
    return {col: df[col].tolist() for col in df.columns}


def df_preview(df: pd.DataFrame, n: int = PREVIEW_ROWS) -> List[dict]:
    """先頭 n 行を list[dict] として返す。"""
    return df.head(n).to_dict(orient="records")

"""レイアウト CSV パーサー: CSV バイト列 → List[QuestionItem]。"""

from __future__ import annotations

import io
import logging
import math
import re
from typing import Dict, List, Literal, Optional, Tuple

import pandas as pd

from app.schemas import ChoiceItem, QuestionItem
from app.utils import decode_text

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 種別コードマッピング
# ---------------------------------------------------------------------------

_OA_TYPE_CODES = {"FA", "F", "OA", "XL"}
_OA_TEXT_KEYWORDS = ["自由回答", "フリーアンサー", "テキスト入力", "その他（記述）", "open answer"]
_AUX_EXCLUDE_TYPES = {"OA_TEXT", "WEIGHT", "FLAG"}

TYPE_LABEL_MAP: Dict[str, str] = {
    # 既存コード
    "SA": "単一回答",
    "MA": "複数回答",
    "FA": "自由回答",
    "NU": "数値",
    "ML": "マトリクスループ",
    # Column/Question/Type/CtgNo/Title 形式の短縮コード
    "S": "単一回答",
    "N": "数値",
    "F": "自由回答",
    "M": "複数回答",
    "X": "特殊",
    "XL": "特殊ループ",
    "SL": "スケールループ",
    "OA": "その他自由回答",
}

# 必須列名（CSV 上の列名）- 日本語形式
REQUIRED_COLS = {"コード", "種別", "質問文"}
OPTIONAL_COLS = {"表側"}

# Column/Question/Type/CtgNo/Title 形式の検出用
_CQT_FORMAT_COLS = {"Question", "Title"}

ChoiceColumnMode = Literal["multi_col", "single_col_delimited", "none"]


# ---------------------------------------------------------------------------
# ヘルパー
# ---------------------------------------------------------------------------

def _safe_str(val) -> str:
    """NaN や None を空文字に変換する。"""
    if val is None:
        return ""
    if isinstance(val, float) and math.isnan(val):
        return ""
    return str(val).strip()


def get_type_label(type_code: str) -> Tuple[str, bool]:
    """(表示名, is_unknown) を返す。未知コードはコードをそのまま表示名にする。"""
    label = TYPE_LABEL_MAP.get(type_code)
    if label:
        return label, False
    return type_code, True


def classify_question_type(q: "QuestionItem") -> str:
    """
    設問を 11 カテゴリに自動分類して返す。

    優先順:
      WEIGHT > FLAG > ATTRIBUTE > DERIVED > OA_TEXT > MATRIX > MA > SA > NUMERIC > UNKNOWN
    """
    code_lower = q.question_code.lower()
    type_upper = (q.type_code or "").upper()
    text = q.question_text or ""
    text_lower = text.lower()
    stub_lower = (q.stub or "").lower()

    # 1. WEIGHT
    if (re.search(r"_weight$", code_lower)
            or "ウェイト" in text
            or "weight" in text_lower
            or "ウェイト" in stub_lower
            or "weight" in stub_lower):
        return "WEIGHT"

    # 2. FLAG
    if ("flag" in code_lower
            or "フラグ" in text
            or "フラグ" in stub_lower):
        return "FLAG"

    # 3. ATTRIBUTE
    if (text.startswith("[属性]")
            or text.startswith("【属性】")
            or text_lower.startswith("[attr]")):
        return "ATTRIBUTE"

    # 4. DERIVED
    if re.search(r"(score|derived|calc|computed)$", code_lower):
        return "DERIVED"

    # 5. OA_TEXT: type_code 優先
    if type_upper in _OA_TYPE_CODES:
        return "OA_TEXT"
    # OA_TEXT: テキストキーワード
    if any(kw in text_lower or kw in stub_lower for kw in _OA_TEXT_KEYWORDS):
        return "OA_TEXT"

    # 6. MATRIX
    if type_upper in {"ML", "SL"}:
        return "MATRIX"

    # 7. MA
    if type_upper in {"MA", "M"}:
        return "MA"

    # 8. SA
    if type_upper in {"SA", "S"}:
        return "SA"

    # 9. NUMERIC
    if type_upper in {"NU", "N"}:
        return "NUMERIC"

    return "UNKNOWN"


def _classify_oa_aux(questions: List["QuestionItem"]) -> List["QuestionItem"]:
    """2パス目: 親が OA_TEXT の子設問を OA_AUX に変更する。"""
    code_to_type = {q.question_code: q.question_type for q in questions}
    for q in questions:
        if (q.is_child
                and q.parent_code
                and code_to_type.get(q.parent_code) == "OA_TEXT"
                and q.question_type not in _AUX_EXCLUDE_TYPES):
            q.question_type = "OA_AUX"
            q.auto_detected_type = "OA_AUX"
    return questions


# ---------------------------------------------------------------------------
# 選択肢列の自動検出
# ---------------------------------------------------------------------------

def detect_choice_columns(cols: List[str]) -> Tuple[ChoiceColumnMode, List[str]]:
    """
    列名リストから選択肢列のモードと対象列を検出する。

    優先順:
    1. `選択肢\\d+` パターンが 2 列以上 → multi_col
    2. `Choice\\d+` 等の英語パターンが 2 列以上 → multi_col
    3. 単一列 `選択肢` / `選択肢テキスト` / `選択肢文` → single_col_delimited
    4. 上記なし → none
    """
    # パターン 1: 選択肢1, 選択肢2, ...
    multi_ja = sorted(
        [c for c in cols if re.fullmatch(r"選択肢\s*\d+", c.strip())],
        key=lambda c: int(re.search(r"\d+", c).group()),
    )
    if len(multi_ja) >= 2:
        return "multi_col", multi_ja

    # パターン 2: Choice1, choice_2, ...（英語）
    multi_en = sorted(
        [c for c in cols if re.fullmatch(r"(?i)choice\s*_?\s*\d+", c.strip())],
        key=lambda c: int(re.search(r"\d+", c).group()),
    )
    if len(multi_en) >= 2:
        return "multi_col", multi_en

    # パターン 3: 単一列
    single_candidates = [
        c for c in cols if c.strip() in ("選択肢", "選択肢テキスト", "選択肢文")
    ]
    if single_candidates:
        return "single_col_delimited", [single_candidates[0]]

    return "none", []


# ---------------------------------------------------------------------------
# 選択肢の抽出
# ---------------------------------------------------------------------------

def _split_delimited(text: str) -> List[str]:
    """区切り文字（| > 改行 > 、）で分割する。"""
    if "|" in text:
        parts = text.split("|")
    elif "\n" in text:
        parts = text.split("\n")
    elif "、" in text:
        parts = text.split("、")
    else:
        parts = [text]
    return [p.strip() for p in parts if p.strip()]


def extract_choices(
    row: pd.Series,
    mode: ChoiceColumnMode,
    choice_cols: List[str],
) -> List[ChoiceItem]:
    """行から選択肢リストを抽出する。"""
    if mode == "multi_col":
        items = []
        for i, col in enumerate(choice_cols):
            text = _safe_str(row.get(col, ""))
            if text:
                items.append(ChoiceItem(choice_index=i, choice_text=text))
        return items

    if mode == "single_col_delimited" and choice_cols:
        raw = _safe_str(row.get(choice_cols[0], ""))
        if not raw:
            return []
        return [
            ChoiceItem(choice_index=i, choice_text=t)
            for i, t in enumerate(_split_delimited(raw))
        ]

    return []


# ---------------------------------------------------------------------------
# 親子関係の検出
# ---------------------------------------------------------------------------

def parse_parent_child(code: str) -> Tuple[bool, Optional[str]]:
    """
    コード文字列から親子関係を判定する。

    Q3_1  → (True,  "Q3")
    Q3_1_2 → (True, "Q3_1")   ← rsplit(maxsplit=1) で直近の親
    Q1    → (False, None)
    """
    if "_" in code:
        parent = code.rsplit("_", 1)[0]
        return True, parent
    return False, None


# ---------------------------------------------------------------------------
# 親設問テキストの解決（2 パス目）
# ---------------------------------------------------------------------------

def _extract_parent_code_from_text(question_text: str) -> Optional[str]:
    """
    質問文の先頭から親コード候補を抽出する。
    例: "Q3 情報収集（業界…）(MA)" → "Q3"
    """
    m = re.match(r"^([A-Za-z]+\d+(?:_\d+)*)\s+", question_text)
    if m:
        return m.group(1)
    return None


def resolve_parent_texts(questions: List[QuestionItem]) -> List[QuestionItem]:
    """
    2 パス目: parent_code に対応する質問文を parent_text に充填する。
    対応する行が存在しない場合は質問文の冒頭パターンから推定する。
    """
    code_to_text: Dict[str, str] = {
        q.question_code: q.question_text for q in questions if not q.is_child
    }
    # 子設問も含めて全コードのマップを作成
    all_code_to_text: Dict[str, str] = {
        q.question_code: q.question_text for q in questions
    }

    for q in questions:
        if not q.is_child or q.parent_code is None:
            continue

        # 直接対応する行がある場合
        if q.parent_code in all_code_to_text:
            q.parent_text = all_code_to_text[q.parent_code]
            continue

        # 対応行がない場合: 質問文の冒頭から推定
        inferred = _extract_parent_code_from_text(q.question_text)
        if inferred and inferred in all_code_to_text:
            q.parent_text = all_code_to_text[inferred]
        else:
            # 質問文をそのまま parent_text とする（同じ質問文を持つ行が多い場合）
            q.parent_text = q.question_text

    return questions


# ---------------------------------------------------------------------------
# Column/Question/Type/CtgNo/Title 形式のパーサー
# ---------------------------------------------------------------------------

_BRACKET_RE = re.compile(r"^(.+)\[(\d+)\]$")


def _is_cqt_format(columns: List[str]) -> bool:
    """Column/Question/Type/CtgNo/Title 形式かどうかを判定する。"""
    col_set = set(columns)
    return _CQT_FORMAT_COLS.issubset(col_set) and "CtgNo" in col_set


def _parse_cqt_format(
    df: pd.DataFrame,
) -> Tuple[List[QuestionItem], List[str], List[str]]:
    """
    Column/Question/Type/CtgNo/Title 形式の DataFrame をパースする。

    Returns:
        questions      : List[QuestionItem]
        parse_warnings : List[str]
        unknown_types  : List[str]
    """
    questions: List[QuestionItem] = []
    code_to_q: Dict[str, QuestionItem] = {}
    last_q: Optional[QuestionItem] = None
    parse_warnings: List[str] = []
    unknown_type_set: set[str] = set()

    for row_idx, row in df.iterrows():
        question_code = _safe_str(row.get("Question", ""))
        type_code = _safe_str(row.get("Type", ""))
        ctg_no = _safe_str(row.get("CtgNo", ""))
        title = _safe_str(row.get("Title", ""))

        if not question_code and not ctg_no:
            continue

        # ── 選択肢行: Question が空で CtgNo が設定されている ──
        if not question_code and ctg_no:
            if last_q is not None:
                idx = int(ctg_no) if ctg_no.isdigit() else len(last_q.choices)
                last_q.choices.append(ChoiceItem(choice_index=idx, choice_text=title))
            else:
                parse_warnings.append(
                    f"行 {int(row_idx) + 2}: 質問なしで選択肢行を検出しました。スキップします。"
                )
            continue

        # ── ブラケット記法変数: Q3_1[1] など ──
        bracket_match = _BRACKET_RE.match(question_code)
        if bracket_match and ctg_no:
            parent_code = bracket_match.group(1)
            idx = int(ctg_no) if ctg_no.isdigit() else int(bracket_match.group(2))
            if parent_code in code_to_q:
                code_to_q[parent_code].choices.append(
                    ChoiceItem(choice_index=idx, choice_text=title)
                )
            else:
                # 親が未定義の場合はスタンドアロンの設問として登録
                parse_warnings.append(
                    f"行 {int(row_idx) + 2}: 親コード「{parent_code}」が未定義のため "
                    f"「{question_code}」を独立した設問として登録します。"
                )
                q = _make_q(question_code, type_code, title, int(row_idx))
                questions.append(q)
                code_to_q[question_code] = q
                last_q = q
            continue

        # ── 通常の設問行 ──
        type_label, is_unknown = get_type_label(type_code)
        if is_unknown and type_code:
            unknown_type_set.add(type_code)

        is_child, parent_code = parse_parent_child(question_code)
        q = QuestionItem(
            question_code=question_code,
            type_code=type_code,
            type_label=type_label,
            question_text=title,
            stub="",
            choices=[],
            parent_code=parent_code,
            parent_text=None,
            is_child=is_child,
            row_index=int(row_idx),
            original_question=question_code,
            original_type=type_code,
            choice_count=0,
        )
        questions.append(q)
        code_to_q[question_code] = q
        last_q = q

    # choice_count と has_children を更新
    parent_codes = {q.parent_code for q in questions if q.parent_code}
    for q in questions:
        q.choice_count = len(q.choices)
        q.has_children = q.question_code in parent_codes

    # question_type 自動分類（1パス目 + OA_AUX 2パス目）
    for q in questions:
        qt = classify_question_type(q)
        q.question_type = qt
        q.auto_detected_type = qt
    questions = _classify_oa_aux(questions)

    return questions, parse_warnings, sorted(unknown_type_set)


def _make_q(code: str, type_code: str, title: str, row_idx: int) -> QuestionItem:
    """QuestionItem を生成するヘルパー。"""
    type_label, _ = get_type_label(type_code)
    is_child, parent_code = parse_parent_child(code)
    return QuestionItem(
        question_code=code,
        type_code=type_code,
        type_label=type_label,
        question_text=title,
        stub="",
        choices=[],
        parent_code=parent_code,
        parent_text=None,
        is_child=is_child,
        row_index=row_idx,
        original_question=code,
        original_type=type_code,
        choice_count=0,
    )


# ---------------------------------------------------------------------------
# メイン関数
# ---------------------------------------------------------------------------

def _parse_layout_df(
    df: pd.DataFrame,
) -> Tuple[List[QuestionItem], List[str], ChoiceColumnMode, List[str]]:
    """
    正規化済み DataFrame をパースして設問リストを返す（CSV・Excel 共通処理）。

    Returns:
        questions        : List[QuestionItem]
        parse_warnings   : List[str]
        choice_col_mode  : ChoiceColumnMode
        unknown_types    : List[str]
    """
    parse_warnings: List[str] = []
    unknown_type_set: set[str] = set()

    # 列名の正規化（前後スペース除去）
    df.columns = [str(c).strip() for c in df.columns]
    all_columns = list(df.columns)

    # --- 形式判定: Column/Question/Type/CtgNo/Title 形式 ---
    if _is_cqt_format(all_columns):
        questions, cqt_warnings, unknown_types = _parse_cqt_format(df)
        parse_warnings.extend(cqt_warnings)
        questions = resolve_parent_texts(questions)
        return questions, parse_warnings, "none", unknown_types

    # --- 日本語形式: 必須列チェック ---
    missing = REQUIRED_COLS - set(df.columns)
    if missing:
        raise ValueError(
            f"必須列が見つかりません: {', '.join(sorted(missing))}。"
            f"CSV の列名を確認してください（現在の列: {', '.join(all_columns)}）"
        )

    # 表側列の存在確認
    has_stub = "表側" in df.columns

    # --- 選択肢列の検出 ---
    choice_col_mode, choice_cols = detect_choice_columns(all_columns)

    if choice_col_mode == "none":
        ambiguous = [c for c in all_columns if "選択肢" in c or "choice" in c.lower()]
        if ambiguous:
            parse_warnings.append(
                f"選択肢列が自動検出できませんでした（候補: {', '.join(ambiguous)}）。"
                "列名が「選択肢1」「選択肢2」…の形式であることを確認してください。"
            )

    # --- 行ごとに設問アイテムを生成 ---
    questions: List[QuestionItem] = []

    for row_idx, row in df.iterrows():
        code = _safe_str(row.get("コード", ""))
        type_code = _safe_str(row.get("種別", ""))
        question_text = _safe_str(row.get("質問文", ""))
        stub = _safe_str(row.get("表側", "")) if has_stub else ""

        if not code:
            parse_warnings.append(f"行 {row_idx + 2}: コードが空です。スキップします。")
            continue

        # 種別マッピング
        type_label, is_unknown = get_type_label(type_code)
        if is_unknown and type_code:
            unknown_type_set.add(type_code)
            parse_warnings.append(
                f"行 {row_idx + 2} (コード: {code}): 未知の種別コード「{type_code}」。"
            )

        # 選択肢抽出
        choices = extract_choices(row, choice_col_mode, choice_cols)

        # 親子判定
        is_child, parent_code = parse_parent_child(code)

        questions.append(QuestionItem(
            question_code=code,
            type_code=type_code,
            type_label=type_label,
            question_text=question_text,
            stub=stub,
            choices=choices,
            parent_code=parent_code,
            parent_text=None,  # 2 パス目で充填
            is_child=is_child,
            row_index=int(row_idx),
            original_question=code,
            original_type=type_code,
            choice_count=len(choices),
        ))

    # --- 2 パス目: parent_text 充填 ---
    questions = resolve_parent_texts(questions)

    # has_children マーキング
    parent_codes = {q.parent_code for q in questions if q.parent_code}
    for q in questions:
        q.has_children = q.question_code in parent_codes

    # question_type 自動分類（1パス目 + OA_AUX 2パス目）
    for q in questions:
        qt = classify_question_type(q)
        q.question_type = qt
        q.auto_detected_type = qt
    questions = _classify_oa_aux(questions)

    unknown_types = sorted(unknown_type_set)
    return questions, parse_warnings, choice_col_mode, unknown_types


# ---------------------------------------------------------------------------
# 公開エントリーポイント
# ---------------------------------------------------------------------------

def parse_layout_csv(
    raw_bytes: bytes,
    encoding: str,
) -> Tuple[List[QuestionItem], List[str], ChoiceColumnMode, List[str]]:
    """レイアウト CSV のバイト列を解析して設問リストを返す。"""
    text = decode_text(raw_bytes, encoding)
    text = text.lstrip("﻿")  # BOM 除去

    try:
        df = pd.read_csv(io.StringIO(text), header=0, dtype=str)
    except Exception as e:
        raise ValueError(f"CSV の読み込みに失敗しました: {e}") from e

    return _parse_layout_df(df)


def parse_layout_excel(
    raw_bytes: bytes,
) -> Tuple[List[QuestionItem], List[str], ChoiceColumnMode, List[str]]:
    """レイアウト Excel (.xlsx) のバイト列を解析して設問リストを返す。"""
    try:
        df = pd.read_excel(io.BytesIO(raw_bytes), header=0, dtype=str, engine="openpyxl")
    except Exception as e:
        raise ValueError(f"Excel ファイルの読み込みに失敗しました: {e}") from e

    return _parse_layout_df(df)

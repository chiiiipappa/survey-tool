"""Pydantic モデル定義。STEP1 の設問構造と将来の分析状態保存を含む。"""

from __future__ import annotations

from typing import Any, List, Literal, Optional, Union

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# 設問アイテム（コアデータ構造）
# ---------------------------------------------------------------------------

class ChoiceItem(BaseModel):
    choice_index: int
    choice_text: str


class QuestionItem(BaseModel):
    question_code: str
    type_code: str
    type_label: str
    question_text: str
    stub: str
    choices: List[ChoiceItem] = Field(default_factory=list)
    parent_code: Optional[str] = None
    parent_text: Optional[str] = None
    is_child: bool = False
    has_children: bool = False
    row_index: int
    original_question: str
    original_type: str
    choice_count: int = 0


# ---------------------------------------------------------------------------
# アップロード
# ---------------------------------------------------------------------------

class UploadResponse(BaseModel):
    status: str = "ok"
    session_token: str
    filename: str
    file_size: int
    encoding_detected: str
    row_count: int
    column_names: List[str]
    choice_column_mode: Literal["multi_col", "single_col_delimited", "none"]
    questions: List[QuestionItem]
    parse_warnings: List[str] = Field(default_factory=list)
    unknown_types: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 設問一覧取得
# ---------------------------------------------------------------------------

class QuestionsResponse(BaseModel):
    session_token: str
    total_count: int
    filtered_count: int
    questions: List[QuestionItem]
    all_type_codes: List[str]
    parse_warnings: List[str] = Field(default_factory=list)


class QuestionsJsonResponse(BaseModel):
    session_token: str
    questions: List[QuestionItem]


# ---------------------------------------------------------------------------
# プロジェクト保存・復元（STEP2 以降で拡張）
# ---------------------------------------------------------------------------

class LayoutFileInfo(BaseModel):
    name: str
    encoding: str
    size: int


class FilterCondition(BaseModel):
    field: str
    operator: str
    value: Union[str, List[str]]


class AxisConfig(BaseModel):
    question_code: str
    label_override: str = ""


class GraphConfig(BaseModel):
    graph_id: str
    graph_type: str = ""
    title: str = ""
    target_question_codes: List[str] = Field(default_factory=list)
    axis_config: Optional[AxisConfig] = None
    aggregation_method: str = "count"
    filter_conditions: List[FilterCondition] = Field(default_factory=list)
    display_order: List[str] = Field(default_factory=list)


class ProjectData(BaseModel):
    """分析状態の完全シリアライズ形式。STEP1 はレイアウト情報+設問構造のみ使用。"""
    version: str = "1.0"
    saved_at: str = ""
    layout_file: LayoutFileInfo
    questions: List[QuestionItem] = Field(default_factory=list)
    parse_warnings: List[str] = Field(default_factory=list)
    # STEP2 以降
    selected_question_codes: List[str] = Field(default_factory=list)
    graphs: List[GraphConfig] = Field(default_factory=list)


class ProjectLoadResponse(BaseModel):
    session_token: str
    questions: List[QuestionItem]
    parse_warnings: List[str]
    graphs: List[GraphConfig]
    load_warnings: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP2: 回答データ読込・ラベル変換
# ---------------------------------------------------------------------------

class AxisCandidateItem(BaseModel):
    question_code: str
    question_text: str
    type_code: str
    type_label: str
    is_default_selected: bool


class UnmatchedValueItem(BaseModel):
    question_code: str
    value: str
    count: int


class BracketColumnItem(BaseModel):
    column_name: str    # "Q3_1[1]"
    base_code: str      # "Q3_1"
    choice_no: int      # 1
    choice_label: str   # "TV・ラジオ・CMなどで見る"
    display_header: str # "Q3_1：TV・ラジオ・CMなどで見る"


class MissingColumnDetail(BaseModel):
    """不足列の分類詳細。不足判定された各レイアウトコードに対する診断結果。"""
    question_code: str
    type_code: str
    type_label: str
    question_text: str
    stub: str
    # verdict: "parent_matched" | "bracket_expanded" | "free_answer" | "need_check" | "unmatched"
    verdict: str
    verdict_label: str
    reason: str
    related_response_cols: List[str] = Field(default_factory=list)


class Step2UploadResponse(BaseModel):
    status: str = "ok"
    filename: str
    file_size: int
    encoding_detected: str
    response_row_count: int
    response_col_count: int
    preview_rows: List[dict]
    labeled_preview_rows: List[dict]
    matched_columns: List[str]
    missing_columns: List[str]
    extra_columns: List[str]
    matched_question_count: int
    unmatched_question_count: int
    codebook: dict
    unmatched_values: List[UnmatchedValueItem]
    axis_candidates: List[AxisCandidateItem]
    multi_select_columns: List[str]
    bracket_columns: List[BracketColumnItem] = Field(default_factory=list)
    missing_column_details: List[MissingColumnDetail] = Field(default_factory=list)


class Step2AxisSaveRequest(BaseModel):
    session_token: str
    selected_axis_columns: List[str]


class Step2StateResponse(BaseModel):
    has_data: bool
    filename: Optional[str] = None
    response_row_count: int = 0
    matched_columns: List[str] = Field(default_factory=list)
    missing_columns: List[str] = Field(default_factory=list)
    extra_columns: List[str] = Field(default_factory=list)
    selected_axis_columns: List[str] = Field(default_factory=list)
    axis_candidates: List[AxisCandidateItem] = Field(default_factory=list)
    multi_select_columns: List[str] = Field(default_factory=list)
    bracket_columns: List[BracketColumnItem] = Field(default_factory=list)
    missing_column_details: List[MissingColumnDetail] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP2: FA閲覧
# ---------------------------------------------------------------------------

class FaColumnInfo(BaseModel):
    question_code: str
    question_text: str
    type_code: str
    type_label: str


class FaAttrCandidate(BaseModel):
    question_code: str
    question_text: str
    type_label: str
    is_fan_do: bool
    is_axis_selected: bool


class FaRow(BaseModel):
    row_index: int
    key_value: str = ""
    attr_values: dict
    question_code: str
    question_text: str
    type_code: str
    type_label: str
    answer: str
    char_count: int
    is_empty: bool = False


class Step2FaMetaResponse(BaseModel):
    fa_columns: List[FaColumnInfo]
    attr_candidates: List[FaAttrCandidate]
    key_column_name: str = ""


class Step2FaResponse(BaseModel):
    fa_columns: List[FaColumnInfo]
    attr_candidates: List[FaAttrCandidate]
    key_column_name: str = ""
    total_fa_rows: int
    filtered_row_count: int
    empty_row_count: int = 0
    rows: List[FaRow]

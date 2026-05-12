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

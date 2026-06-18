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
    question_type: str = "UNKNOWN"           # 11-category 分析用分類
    auto_detected_type: str = "UNKNOWN"      # 自動判定値（不変）
    manual_override_type: Optional[str] = None  # ユーザー上書き


# ---------------------------------------------------------------------------
# アップロード
# ---------------------------------------------------------------------------

class UploadResponse(BaseModel):
    status: str = "ok"
    session_token: str
    filename: str
    file_size: int
    encoding_detected: str
    row_count: int = 0
    column_names: List[str] = Field(default_factory=list)
    choice_column_mode: Literal["multi_col", "single_col_delimited", "none"] = "none"
    questions: List[QuestionItem] = Field(default_factory=list)
    parse_warnings: List[str] = Field(default_factory=list)
    unknown_types: List[str] = Field(default_factory=list)
    detected_format: str = ""
    format_info: dict = Field(default_factory=dict)
    format_hint: str = "auto"
    format_confidence: float = 0.0
    survey_format: str = "unknown"
    needs_manual_mapping: bool = False
    available_columns: List[str] = Field(default_factory=list)


class RemapRequest(BaseModel):
    session_token: str
    col_mapping: dict


class ReparseRequest(BaseModel):
    session_token: str
    format_hint: str = "auto"


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


class LabelFixRule(BaseModel):
    question_code: str
    raw_value: str
    label: str


class LabelFixRequest(BaseModel):
    session_token: str
    fixes: List[LabelFixRule]


class LabelFixResponse(BaseModel):
    status: str = "ok"
    applied_count: int
    remaining_unmatched: List[UnmatchedValueItem]
    labeled_preview_rows: List[dict]
    warnings: List[str] = Field(default_factory=list)


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
    all_response_columns: List[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP2: 手動照合
# ---------------------------------------------------------------------------

class ManualMatchRule(BaseModel):
    layout_code: str
    response_cols: List[str] = Field(default_factory=list)


class ManualMatchRequest(BaseModel):
    session_token: str
    rules: List[ManualMatchRule]


class ManualMatchResponse(BaseModel):
    status: str = "ok"
    matched_columns: List[str]
    extra_columns: List[str]
    missing_column_details: List[MissingColumnDetail]
    labeled_preview_rows: List[dict] = Field(default_factory=list)
    unmatched_values: List[UnmatchedValueItem] = Field(default_factory=list)
    manual_match_rules: List[dict] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


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


# ---------------------------------------------------------------------------
# プロジェクト保存・復元 v2（ZIP/.surv 形式）
# ---------------------------------------------------------------------------

class Step2FaSettingsRequest(BaseModel):
    session_token: str
    selected_fa_codes: List[str] = Field(default_factory=list)
    selected_attr_columns: List[str] = Field(default_factory=list)



class ProjectSaveRequest(BaseModel):
    session_token: str
    project_name: str = ""
    step3_chart_type_map: dict = Field(default_factory=dict)    # 後方互換
    step3_question_settings: dict = Field(default_factory=dict)  # 新
    step1_axis_colors: dict = Field(default_factory=dict)
    user_palettes: dict = Field(default_factory=dict)
    step3_secondary_axis_code: str = ""
    step3_composite_display_mode: str = "split"
    step3_color_priority: str = "axis1"
    step3_min_sample_size: int = 0
    step3_target_filter_column: str = ""
    step3_target_filter_values: List[str] = Field(default_factory=list)
    question_sets: List[dict] = Field(default_factory=list)
    step3_crosstab_cache: dict = Field(default_factory=dict)
    hidden_question_types: List[str] = Field(default_factory=list)
    excluded_questions: List[str] = Field(default_factory=list)
    step3_views: dict = Field(default_factory=dict)
    report_project: dict = Field(default_factory=dict)
    chart_results: List[dict] = Field(default_factory=list)
    layout_format: str = "auto"
    response_format: str = "auto"
    score_settings: dict = Field(default_factory=dict)  # 平均点分析: question_code -> ScaleSettings
    score_mapping: dict = Field(default_factory=dict)    # 平均点分析: question_code -> ScoreMappingEntry[]


class LayoutSaveData(BaseModel):
    layout_file: LayoutFileInfo
    questions: List[QuestionItem] = Field(default_factory=list)
    parse_warnings: List[str] = Field(default_factory=list)
    choice_column_mode: str = "none"
    all_type_codes: List[str] = Field(default_factory=list)
    layout_format: str = "auto"
    response_format: str = "auto"
    step3_active_axis_code: str = ""
    step3_chart_type_map: dict = Field(default_factory=dict)     # 後方互換
    step3_question_settings: dict = Field(default_factory=dict)  # 新
    step1_axis_colors: dict = Field(default_factory=dict)
    user_palettes: dict = Field(default_factory=dict)
    step3_mode: str = "brand_comparison"
    step3_basic_axis_code: str = ""
    step3_comparison_axis_code: str = ""
    step3_deep_dive_target: str = ""
    step3_secondary_axis_code: str = ""
    step3_composite_display_mode: str = "split"
    step3_color_priority: str = "axis1"
    step3_min_sample_size: int = 0
    question_sets: List[dict] = Field(default_factory=list)
    step3_crosstab_cache: dict = Field(default_factory=dict)
    hidden_question_types: List[str] = Field(default_factory=list)
    excluded_questions: List[str] = Field(default_factory=list)
    step3_target_filter_column: str = ""
    step3_target_filter_values: List[str] = Field(default_factory=list)
    step3_views: dict = Field(default_factory=dict)
    report_project: dict = Field(default_factory=dict)
    chart_results: List[dict] = Field(default_factory=list)
    score_settings: dict = Field(default_factory=dict)  # 平均点分析: question_code -> ScaleSettings
    score_mapping: dict = Field(default_factory=dict)    # 平均点分析: question_code -> ScoreMappingEntry[]


class Step2SaveData(BaseModel):
    filename: str = ""
    encoding: str = ""
    file_size: int = 0
    raw_data: dict = Field(default_factory=dict)
    labeled_data: dict = Field(default_factory=dict)
    codebook: dict = Field(default_factory=dict)
    matched_columns: List[str] = Field(default_factory=list)
    missing_columns: List[str] = Field(default_factory=list)
    extra_columns: List[str] = Field(default_factory=list)
    bracket_columns: List[dict] = Field(default_factory=list)
    missing_column_details: List[dict] = Field(default_factory=list)
    unmatched_values: List[dict] = Field(default_factory=list)
    response_row_count: int = 0
    response_col_count: int = 0
    axis_candidates: List[dict] = Field(default_factory=list)
    selected_axis_columns: List[str] = Field(default_factory=list)
    selected_axis_labels: dict = Field(default_factory=dict)
    axis_display_order: List[str] = Field(default_factory=list)
    axis_filter_settings: dict = Field(default_factory=dict)
    multi_select_columns: List[str] = Field(default_factory=list)
    selected_fa_codes: List[str] = Field(default_factory=list)
    selected_attr_columns: List[str] = Field(default_factory=list)
    manual_match_rules: List[dict] = Field(default_factory=list)
    manual_label_fixes: List[dict] = Field(default_factory=list)
    all_response_columns: List[str] = Field(default_factory=list)


class CrosstabConfig(BaseModel):
    """STEP3 クロス集計設定（将来用）"""
    config_id: str = ""
    axis_question_code: str = ""
    target_question_codes: List[str] = Field(default_factory=list)
    crosstab_type: str = ""
    graph_type: str = ""
    display_order: List[str] = Field(default_factory=list)
    show: bool = True
    show_count: bool = True
    show_percent: bool = True
    sort_settings: dict = Field(default_factory=dict)
    color_settings: dict = Field(default_factory=dict)
    comment: str = ""


class FullProjectLoadResponse(BaseModel):
    session_token: str
    project_name: str = ""
    saved_at: str = ""
    layout: LayoutSaveData
    has_step2: bool = False
    step2: Optional[Step2SaveData] = None
    step3_crosstab_configs: List[CrosstabConfig] = Field(default_factory=list)
    step3_active_axis_code: str = ""
    load_warnings: List[str] = Field(default_factory=list)
    report_project: dict = Field(default_factory=dict)
    layout_format: str = "auto"
    response_format: str = "auto"


# ---------------------------------------------------------------------------
# STEP3: クロス集計
# ---------------------------------------------------------------------------

class Step3CrosstabRequest(BaseModel):
    session_token: str
    axis_question_code: str
    secondary_axis_question_code: str = ""
    target_question_codes: List[str] = Field(default_factory=list)
    target_filter_column: str = ""
    target_filter_values: List[str] = Field(default_factory=list)
    avg_indicator_codes: List[str] = Field(default_factory=list)


class CrosstabRow(BaseModel):
    label: str
    counts: List[int]
    percents: List[float]


class CrosstabResult(BaseModel):
    question_code: str
    question_text: str
    type_code: str
    rows: List[CrosstabRow]


class AvgIndicatorResult(BaseModel):
    """通常分析で基本軸カテゴリ別に集計した平均点指標の結果。"""
    indicator_code: str
    indicator_name: str
    stats: List[AverageAxisStat]


class Step3CrosstabResponse(BaseModel):
    axis_question_code: str
    axis_question_text: str
    axis_categories: List[str]
    axis_totals: List[int]
    results: List[CrosstabResult]
    warnings: List[str] = Field(default_factory=list)
    secondary_axis_question_code: str = ""
    secondary_axis_question_text: str = ""
    primary_axis_categories: List[str] = Field(default_factory=list)
    secondary_axis_categories: List[str] = Field(default_factory=list)
    avg_indicator_results: List[AvgIndicatorResult] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP3: 特定分析（属性分析・ファン度分析・平均点分析）
# ---------------------------------------------------------------------------

class AverageAxisStat(BaseModel):
    """平均点分析: 1カテゴリ分の統計量（全体 or 属性別の1行）。"""
    category: str
    n_valid: int = 0
    n_excluded: int = 0
    mean: Optional[float] = None
    std: Optional[float] = None
    median: Optional[float] = None
    min: Optional[float] = None
    max: Optional[float] = None


class Step3SpecialBlock(Step3CrosstabResponse):
    """特定分析の1結果ブロック（結果切替タブの単位）。"""
    block_label: str
    axis_stats: List[AverageAxisStat] = Field(default_factory=list)  # 平均点分析でのみ使用


class Step3SpecialResponse(BaseModel):
    blocks: List[Step3SpecialBlock] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class AttributeCrossPair(BaseModel):
    row_code: str
    col_code: str


class AttributeAnalysisRequest(BaseModel):
    session_token: str
    simple_tally_codes: List[str] = Field(default_factory=list)
    cross_pairs: List[AttributeCrossPair] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP3: ファン度分析 — 新ファン度（好意度×応援意向）/旧ファン度（好意度×ファンステージ）/カスタム
# ---------------------------------------------------------------------------
#
# 新旧ファン度は設問形式が異なるため別ロジックで判定するが、共通化できるのは
# 「2設問を選ぶ→行×列の判定マトリクスを作る→セルにラベルを割り当てる→
#  回答者ごとに該当セルを見てfan_degreeを付与する→集計する」という処理の骨格のみ。
# 新旧それぞれの違い（設問自動検出・初期マトリクス）はフロントエンド側で吸収する。

class FanDegreeMatrixCell(BaseModel):
    """ファン度判定マトリクスの1セル（行選択肢×列選択肢→ラベル）。"""
    row_value: str
    col_value: str
    label: str = ""  # ""=未設定（判定不能になる）


class FanAnalysisRequest(BaseModel):
    session_token: str
    fan_degree_type: Literal["new", "old", "custom"] = "new"
    row_question_code: str
    col_question_code: str
    row_question_role: str = ""  # 表示用ラベル（好意度/縦軸 等）
    col_question_role: str = ""  # 表示用ラベル（応援意向/ファンステージ/横軸 等）
    matrix: List[FanDegreeMatrixCell] = Field(default_factory=list)
    denominator_mode: Literal["all", "valid", "excluding_undetermined", "filtered"] = "valid"
    target_filter_column: str = ""
    target_filter_values: List[str] = Field(default_factory=list)


class FanDegreeCount(BaseModel):
    label: str
    n: int = 0
    pct: float = 0.0
    cum_pct: float = 0.0


class FanDegreeSummary(BaseModel):
    counts: List[FanDegreeCount] = Field(default_factory=list)
    denominator_n: int = 0
    denominator_mode: str = "valid"
    core_fan_rate: float = 0.0
    fan_or_above_rate: float = 0.0
    light_fan_or_above_rate: float = 0.0
    undetermined_n: int = 0
    excluded_n: int = 0


class FanDegreeRespondentRow(BaseModel):
    response_id: int
    row_answer: str
    col_answer: str
    fan_degree_label: str
    status: str  # "判定済" | "判定不能"
    is_core_fan: int = 0
    is_fan_or_above: int = 0
    is_light_fan_or_above: int = 0
    is_fan_degree_valid: int = 0


class FanAnalysisResponse(BaseModel):
    blocks: List[Step3SpecialBlock] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    summary: FanDegreeSummary = Field(default_factory=FanDegreeSummary)
    matrix: List[FanDegreeMatrixCell] = Field(default_factory=list)
    row_question_code: str = ""
    row_question_text: str = ""
    col_question_code: str = ""
    col_question_text: str = ""
    row_categories: List[str] = Field(default_factory=list)
    col_categories: List[str] = Field(default_factory=list)
    respondent_rows: List[FanDegreeRespondentRow] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP3: ファン度分析結果を通常分析の派生属性として保存する
# ---------------------------------------------------------------------------
#
# ファン度分析画面では判定のみを行い、属性別の内訳は通常分析側で
# fan_degree_label を集計軸として使うことで実現する。そのために、判定結果を
# response_id（データフレームの行位置）をキーに通常分析用データへ列として
# 永続化（labeled_parquetへ追記）し、STEP1設問マスタにも仮想設問として登録する。

class FanDegreeSaveRequest(BaseModel):
    session_token: str
    fan_degree_type: Literal["new", "old", "custom"]
    row_question_code: str
    col_question_code: str
    matrix: List[FanDegreeMatrixCell] = Field(default_factory=list)
    overwrite: bool = False


class FanDegreeSaveResponse(BaseModel):
    message: str
    overwritten: bool
    axis_questions: List[QuestionItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# STEP3: 平均点分析 — スコア設定（「データは何点満点か」→「表示は何点満点か」の換算）
# ---------------------------------------------------------------------------

class ScaleSettings(BaseModel):
    """設問単位の尺度設定。最低値/最高点は尺度全体の範囲であり、選択肢個別の点数ではない。

    UI文言: data_*_score = 「データの満点/最低値」, display_*_score = 「表示する満点/最低点」。
    calc_method: linear=線形換算（既定） / raw=選択肢の数値をそのまま使う / manual=手動スコアのみ使う。
    """
    data_min_score: float = 0
    data_max_score: float
    display_min_score: float = 0
    display_max_score: float
    scale_direction: Literal["forward", "reverse"] = "forward"
    calc_method: Literal["linear", "raw", "manual"] = "linear"


class ScoreMappingEntry(BaseModel):
    """選択肢単位のスコアマッピング1行（score_mappingテーブル相当）。"""
    choice_text: str
    raw_score: Optional[float] = None
    converted_score: Optional[float] = None
    manual_score: Optional[float] = None
    final_score: Optional[float] = None
    exclude_flag: bool = False
    missing_flag: bool = False


class AverageAnalysisTarget(BaseModel):
    question_code: str
    scale_settings: ScaleSettings
    choice_scores: List[ScoreMappingEntry] = Field(default_factory=list)


class AverageAnalysisRequest(BaseModel):
    session_token: str
    targets: List[AverageAnalysisTarget]


# ---------------------------------------------------------------------------
# STEP3: 属性軸・平均点指標を通常分析へ保存する
# ---------------------------------------------------------------------------

class AttributeSaveAsAxisRequest(BaseModel):
    session_token: str
    row_code: str
    col_code: str       # row_code と同じ場合は単一軸のエイリアス
    axis_name: str      # ユーザー定義の表示名（例: "性年代"）
    overwrite: bool = False


class AttributeSaveAsAxisResponse(BaseModel):
    axis_questions: List[QuestionItem]
    saved_column: str


class AverageSaveAsIndicatorRequest(BaseModel):
    session_token: str
    question_code: str
    scale_settings: ScaleSettings
    choice_scores: List[ScoreMappingEntry]
    indicator_name: str  # 例: "顧客幸福度"
    overwrite: bool = False


class AverageSaveAsIndicatorResponse(BaseModel):
    indicator_question: QuestionItem
    saved_column: str


class TriMatrixCell(BaseModel):
    score: int   # 0〜10
    label: str   # "高" | "中" | "低"


class AverageSaveDerivedRequest(BaseModel):
    session_token: str
    question_code: str
    base_name: str          # 例: "顧客幸福度" → raw="顧客幸福度点数", tri="顧客幸福度 3区分"
    choice_scores: List[ScoreMappingEntry]
    tri_matrix: List[TriMatrixCell]
    overwrite: bool = False


class AverageSaveDerivedResponse(BaseModel):
    raw_question: QuestionItem
    tri_question: QuestionItem


# ---------------------------------------------------------------------------
# STEP3 エクスポート用スキーマ
# ---------------------------------------------------------------------------

class ExportQuestionRow(BaseModel):
    label: str
    percents: List[float]
    counts: List[int]


class ExportQuestion(BaseModel):
    question_code: str
    question_text: str
    type_code: str
    chart_type: str = "bar"       # bar|grouped|stacked100|pie|avg_bar|table_only
    orientation: str = "v"        # v|h
    show_pct_label: bool = True
    transpose: bool = False
    graph_title: str = ""         # 空文字なら question_text を使用
    resolved_colors: List[str] = Field(default_factory=list)
    rows: List[ExportQuestionRow] = Field(default_factory=list)


class Step3ExportRequest(BaseModel):
    axis_question_code: str
    axis_question_text: str
    axis_categories: List[str]
    axis_totals: List[int]
    questions: List[ExportQuestion]


# ---------------------------------------------------------------------------
# レポート生成
# ---------------------------------------------------------------------------

class ReportAxisSpec(BaseModel):
    type: Literal["total", "column"]
    column_code: str = ""   # type=column のとき使用


class ReportGenerateRequest(BaseModel):
    session_token: str
    mode: Literal["comparison", "single"]
    target_column: str = ""       # 分析対象列（空=フィルタなし）
    target_values: List[str] = Field(default_factory=list)  # 分析対象値
    question_codes: List[str]     # 分析設問コード
    axis_specs: List[ReportAxisSpec]  # 分析軸設定


class ReportRow(BaseModel):
    label: str
    percents: List[float]
    counts: List[int]


class ReportComparisonDataset(BaseModel):
    target_value: str
    axis_categories: List[str]
    axis_totals: List[int]
    rows: List[ReportRow]


class ReportPageData(BaseModel):
    page_id: str
    mode: str
    title: str
    question_code: str
    question_text: str
    type_code: str
    axis_code: str       # "" for total
    axis_label: str      # "全体" / 軸の質問文
    # 比較+全体 / 単一+軸: 通常クロス集計形式
    axis_categories: List[str]
    axis_totals: List[int]
    rows: List[ReportRow]
    # 比較+軸: 対象ごとのサブデータ（スモールマルチプル用）
    comparison_datasets: List[ReportComparisonDataset] = Field(default_factory=list)


class ReportGenerateResponse(BaseModel):
    pages: List[ReportPageData]
    warnings: List[str] = Field(default_factory=list)

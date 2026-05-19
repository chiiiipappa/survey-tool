/**
 * アプリケーション状態管理シングルトン。
 * カスタムイベント "survey:statechange" で変更を通知する。
 */
const _AXIS_TYPE_CODES = new Set(["SA", "S", "NU", "N"]);

function deriveStep1AxisDefaults(questions) {
  return (questions ?? [])
    .filter(q =>
      _AXIS_TYPE_CODES.has((q.type_code ?? "").toUpperCase()) &&
      !q.has_children &&
      /[*＊]ファンラベル/.test(q.question_text ?? "")
    )
    .map(q => q.question_code);
}

export const AppState = {
  // セッション
  sessionToken: null,
  // ファイル情報
  loadedAt: null,
  sourceFilename: null,
  sourceEncoding: "",
  fileSize: 0,
  choiceColumnMode: "",
  rowCount: 0,
  // 設問データ
  questions: [],
  allTypeCodes: [],
  parseWarnings: [],
  // STEP1: 集計軸選択
  step1AxisCodes: [],
  // UI
  activePanel: "upload",
  searchText: "",
  typeFilter: "",
  includeChildren: true,
  // STEP2: 回答データ
  step2Filename: null,
  step2Encoding: "",
  step2FileSize: 0,
  step2RowCount: 0,
  step2ColCount: 0,
  step2PreviewRows: [],
  step2LabeledPreviewRows: [],
  step2MatchedColumns: [],
  step2MissingColumns: [],
  step2ExtraColumns: [],
  step2Codebook: {},
  step2AxisCandidates: [],
  step2SelectedAxisColumns: [],
  step2UnmatchedValues: [],
  step2MultiSelectColumns: [],
  step2AttrCandidates: [],
  step2SelectedAttrColumns: [],
  // STEP2 FA 永続化
  step2SelectedFaCodes: [],
  // プロジェクト管理
  projectName: "",
  projectSavedAt: null,   // Date | null
  isDirty: false,
  // STEP1 カラー設定
  step1AxisColors: {},  // { axis_question_code: { fixedPalette: string | null } }
  // STEP3
  step3CrosstabConfigs: [],
  step3ActiveAxisCode: "",
  step3LastGeneratedAxisCode: "",
  step3QuestionSettings: {},  // { question_code: QuestionSettings }
};

function _emit() {
  document.dispatchEvent(new CustomEvent("survey:statechange", { detail: { ...AppState } }));
}

export function markDirty() {
  AppState.isDirty = true;
  _emit();
}

export function markClean(savedAt) {
  AppState.isDirty = false;
  AppState.projectSavedAt = savedAt ?? new Date();
  _emit();
}

export function setProjectName(name) {
  AppState.projectName = name ?? "";
  _emit();
}

export function setStep2FaCodes(codes) {
  AppState.step2SelectedFaCodes = Array.isArray(codes) ? [...codes] : [];
  _emit();
}

export function setStep3Configs(configs) {
  AppState.step3CrosstabConfigs = Array.isArray(configs) ? [...configs] : [];
  _emit();
}

export function setStep3ActiveAxis(code) {
  AppState.step3ActiveAxisCode = code ?? "";
  AppState.isDirty = true;
  _emit();
}

export function setStep3Setting(questionCode, key, value) {
  const existing = AppState.step3QuestionSettings[questionCode] ?? {};
  AppState.step3QuestionSettings = {
    ...AppState.step3QuestionSettings,
    [questionCode]: { ...existing, [key]: value },
  };
  AppState.isDirty = true;
  _emit();
}

export function setStep3SettingsBulk(updates) {
  const next = { ...AppState.step3QuestionSettings };
  for (const [qCode, partial] of Object.entries(updates)) {
    next[qCode] = { ...(next[qCode] ?? {}), ...partial };
  }
  AppState.step3QuestionSettings = next;
  AppState.isDirty = true;
  _emit();
}

export function setStep1FixedPalette(axisCode, paletteKey) {
  AppState.step1AxisColors = {
    ...AppState.step1AxisColors,
    [axisCode]: { fixedPalette: paletteKey },
  };
  AppState.isDirty = true;
  _emit();
}

export function clearStep1FixedPalette(axisCode) {
  const next = { ...AppState.step1AxisColors };
  delete next[axisCode];
  AppState.step1AxisColors = next;
  AppState.isDirty = true;
  _emit();
}

export function setUploadResult(resp) {
  AppState.sessionToken    = resp.session_token;
  AppState.loadedAt        = new Date();
  AppState.sourceFilename  = resp.filename;
  AppState.sourceEncoding  = resp.encoding_detected;
  AppState.fileSize        = resp.file_size;
  AppState.choiceColumnMode = resp.choice_column_mode;
  AppState.rowCount        = resp.row_count;
  AppState.questions       = resp.questions ?? [];
  AppState.allTypeCodes    = resp.all_type_codes ?? [];
  AppState.parseWarnings   = resp.parse_warnings ?? [];
  AppState.step1AxisCodes  = deriveStep1AxisDefaults(AppState.questions);
  AppState.isDirty         = true;
  _emit();
}

export function setLoadedProject(resp) {
  AppState.sessionToken    = resp.session_token;
  AppState.projectName     = resp.project_name ?? "";
  AppState.projectSavedAt  = resp.saved_at ? new Date(resp.saved_at) : null;
  AppState.isDirty         = false;

  const layout = resp.layout;
  AppState.questions       = layout.questions ?? [];
  AppState.parseWarnings   = layout.parse_warnings ?? [];
  AppState.allTypeCodes    = layout.all_type_codes?.length
    ? layout.all_type_codes
    : [...new Set((layout.questions ?? []).map(q => q.type_code).filter(Boolean))].sort();
  AppState.step1AxisCodes  = layout.step1_axis_codes?.length
    ? layout.step1_axis_codes
    : deriveStep1AxisDefaults(AppState.questions);
  AppState.choiceColumnMode = layout.choice_column_mode ?? "";

  if (resp.has_step2 && resp.step2) {
    const s2 = resp.step2;
    AppState.step2Filename            = s2.filename ?? null;
    AppState.step2Encoding            = s2.encoding ?? "";
    AppState.step2FileSize            = s2.file_size ?? 0;
    AppState.step2RowCount            = s2.response_row_count ?? 0;
    AppState.step2ColCount            = s2.response_col_count ?? 0;
    AppState.step2MatchedColumns      = s2.matched_columns ?? [];
    AppState.step2MissingColumns      = s2.missing_columns ?? [];
    AppState.step2ExtraColumns        = s2.extra_columns ?? [];
    AppState.step2Codebook            = s2.codebook ?? {};
    AppState.step2AxisCandidates      = s2.axis_candidates ?? [];
    AppState.step2SelectedAxisColumns = s2.selected_axis_columns ?? [];
    AppState.step2UnmatchedValues     = s2.unmatched_values ?? [];
    AppState.step2MultiSelectColumns  = s2.multi_select_columns ?? [];
    AppState.step2SelectedFaCodes     = s2.selected_fa_codes ?? [];
    AppState.step2SelectedAttrColumns = s2.selected_attr_columns ?? [];
    // プレビュー行は保存対象外
    AppState.step2PreviewRows         = [];
    AppState.step2LabeledPreviewRows  = [];
  }

  AppState.step3CrosstabConfigs = resp.step3_crosstab_configs ?? [];
  AppState.step3ActiveAxisCode = resp.step3_active_axis_code ?? "";
  AppState.step3LastGeneratedAxisCode = "";
  // 旧 step3_chart_type_map からのマイグレーション + 新 step3_question_settings の復元
  const _oldMap = resp.layout?.step3_chart_type_map ?? {};
  const _newSettings = resp.layout?.step3_question_settings ?? {};
  const _migrated = {};
  for (const [k, v] of Object.entries(_oldMap)) {
    if (!_newSettings[k]) {
      _migrated[k] = v === "hbar" ? { chartType: "bar", orientation: "h" }
                   : v === "vbar" ? { chartType: "bar", orientation: "v" }
                   : { chartType: v };
    }
  }
  AppState.step3QuestionSettings = { ..._migrated, ..._newSettings };
  AppState.step1AxisColors = resp.layout?.step1_axis_colors ?? {};
  _emit();
}

export function setQuestionsResult(resp) {
  AppState.allTypeCodes  = resp.all_type_codes ?? AppState.allTypeCodes;
  AppState.parseWarnings = resp.parse_warnings ?? AppState.parseWarnings;
  _emit();
}

export function setActivePanel(panel) {
  AppState.activePanel = panel;
  _emit();
}

export function setFilterState({ searchText, typeFilter, includeChildren }) {
  if (searchText !== undefined)    AppState.searchText    = searchText;
  if (typeFilter !== undefined)    AppState.typeFilter    = typeFilter;
  if (includeChildren !== undefined) AppState.includeChildren = includeChildren;
  _emit();
}

export function setStep2UploadResult(resp) {
  AppState.step2Filename          = resp.filename;
  AppState.step2Encoding          = resp.encoding_detected;
  AppState.step2FileSize          = resp.file_size;
  AppState.step2RowCount          = resp.response_row_count;
  AppState.step2ColCount          = resp.response_col_count;
  AppState.step2PreviewRows       = resp.preview_rows ?? [];
  AppState.step2LabeledPreviewRows = resp.labeled_preview_rows ?? [];
  AppState.step2MatchedColumns    = resp.matched_columns ?? [];
  AppState.step2MissingColumns    = resp.missing_columns ?? [];
  AppState.step2ExtraColumns      = resp.extra_columns ?? [];
  AppState.step2Codebook          = resp.codebook ?? {};
  AppState.step2AxisCandidates    = resp.axis_candidates ?? [];
  AppState.step2SelectedAxisColumns = (resp.axis_candidates ?? [])
    .filter(c => c.is_default_selected)
    .map(c => c.question_code);
  AppState.step2UnmatchedValues   = resp.unmatched_values ?? [];
  AppState.step2MultiSelectColumns = resp.multi_select_columns ?? [];
  AppState.isDirty = true;
  _emit();
}

export function setStep2AxisSelection(cols) {
  AppState.step2SelectedAxisColumns = cols;
  AppState.isDirty = true;
  _emit();
}

export function setStep2FaMeta(meta) {
  AppState.step2AttrCandidates = meta.attr_candidates ?? [];
  AppState.step2SelectedAttrColumns = (meta.attr_candidates ?? [])
    .filter(c => c.is_axis_selected)
    .map(c => c.question_code);
  _emit();
}

export function setStep2AttrSelection(cols) {
  AppState.step2SelectedAttrColumns = cols;
  AppState.isDirty = true;
  _emit();
}

export function setStep1AxisCodes(codes) {
  AppState.step1AxisCodes = Array.isArray(codes) ? [...codes] : [];
  AppState.isDirty = true;
  _emit();
}

export function resetState() {
  AppState.sessionToken    = null;
  AppState.loadedAt        = null;
  AppState.sourceFilename  = null;
  AppState.sourceEncoding  = "";
  AppState.fileSize        = 0;
  AppState.choiceColumnMode = "";
  AppState.rowCount        = 0;
  AppState.questions       = [];
  AppState.allTypeCodes    = [];
  AppState.parseWarnings   = [];
  AppState.searchText      = "";
  AppState.typeFilter      = "";
  AppState.includeChildren = true;
  AppState.step2Filename   = null;
  AppState.step2Encoding   = "";
  AppState.step2FileSize   = 0;
  AppState.step2RowCount   = 0;
  AppState.step2ColCount   = 0;
  AppState.step2PreviewRows = [];
  AppState.step2LabeledPreviewRows = [];
  AppState.step2MatchedColumns = [];
  AppState.step2MissingColumns = [];
  AppState.step2ExtraColumns   = [];
  AppState.step2Codebook       = {};
  AppState.step2AxisCandidates = [];
  AppState.step2SelectedAxisColumns = [];
  AppState.step2UnmatchedValues = [];
  AppState.step2MultiSelectColumns = [];
  AppState.step2AttrCandidates = [];
  AppState.step2SelectedAttrColumns = [];
  AppState.step1AxisCodes = [];
  AppState.step2SelectedFaCodes = [];
  AppState.projectName     = "";
  AppState.projectSavedAt  = null;
  AppState.isDirty         = false;
  AppState.step3CrosstabConfigs = [];
  AppState.step3ActiveAxisCode = "";
  AppState.step3LastGeneratedAxisCode = "";
  AppState.step3QuestionSettings = {};
  _emit();
}

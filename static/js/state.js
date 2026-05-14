/**
 * アプリケーション状態管理シングルトン。
 * カスタムイベント "survey:statechange" で変更を通知する。
 */
export const AppState = {
  // セッション
  sessionToken: null,
  // ファイル情報
  sourceFilename: null,
  sourceEncoding: "",
  fileSize: 0,
  choiceColumnMode: "",
  rowCount: 0,
  // 設問データ
  questions: [],
  allTypeCodes: [],
  parseWarnings: [],
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
};

function _emit() {
  document.dispatchEvent(new CustomEvent("survey:statechange", { detail: { ...AppState } }));
}

export function setUploadResult(resp) {
  AppState.sessionToken    = resp.session_token;
  AppState.sourceFilename  = resp.filename;
  AppState.sourceEncoding  = resp.encoding_detected;
  AppState.fileSize        = resp.file_size;
  AppState.choiceColumnMode = resp.choice_column_mode;
  AppState.rowCount        = resp.row_count;
  AppState.questions       = resp.questions ?? [];
  AppState.allTypeCodes    = resp.all_type_codes ?? [];
  AppState.parseWarnings   = resp.parse_warnings ?? [];
  _emit();
}

export function setLoadedProject(resp) {
  AppState.sessionToken   = resp.session_token;
  AppState.questions      = resp.questions ?? [];
  AppState.parseWarnings  = resp.parse_warnings ?? [];
  AppState.allTypeCodes   = [...new Set((resp.questions ?? []).map(q => q.type_code).filter(Boolean))].sort();
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
  _emit();
}

export function setStep2AxisSelection(cols) {
  AppState.step2SelectedAxisColumns = cols;
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
  _emit();
}

export function resetState() {
  AppState.sessionToken    = null;
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
  _emit();
}

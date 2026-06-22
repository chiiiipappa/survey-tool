/**
 * アプリケーション状態管理シングルトン。
 * カスタムイベント "survey:statechange" で変更を通知する。
 */
const _AUTO_EXCLUDE_TYPES = new Set(["OA_AUX", "FLAG", "DERIVED"]);

function _deriveExcludedDefaults(questions) {
  return (questions ?? [])
    .filter(q => _AUTO_EXCLUDE_TYPES.has(q.question_type ?? ""))
    .map(q => q.question_code);
}

// ---------------------------------------------------------------------------
// 自動カラー設定
// 設問の選択肢数に応じてデフォルトの valueColorMapping を生成する。
// ---------------------------------------------------------------------------

const _AC_7  = ["#9D174D","#EC4899","#F9A8D4","#D9D9D9","#93C5FD","#3B82F6","#1E3A8A"];
const _AC_8A = ["#3B0603","#782535","#AA355D","#DF5088","#ED80B8","#F3B0E7","#FAE2FD","#676767"];
const _AC_8B = ["#3B0603","#782535","#AA355D","#DF5088","#ED80B8","#F3B0E7","#FAE2FD","#D9D9D9"];
const _AC_11 = ["#9D174D","#DB2777","#EC4899","#F472B6","#F9A8D4","#D9D9D9","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"];

const _AC_SCALE_KW = /とても|やや|どちら|あまり|まったく|そう思う|あてはまる|満足|好き|評価|意向|推奨/;

/**
 * 設問オブジェクトから自動 valueColorMapping を生成して返す。
 * 対象外の場合は null を返す。
 * @param {object} question - { choices: [{choice_text}], ... }
 * @returns {{label: string, color: string}[] | null}
 */
export function computeAutoColorMapping(question) {
  const choices = (question?.choices ?? []).map(c => c.choice_text).filter(Boolean);
  const n = choices.length;

  // ファンラベル系は FIXED_PALETTES で対応するためスキップ
  if (choices.some(l => /コアファン/.test(l)) && choices.some(l => /ライトファン/.test(l))) return null;

  let palette;
  if (n === 7) {
    palette = _AC_7;
  } else if (n === 8) {
    const isScale = choices.some(t => _AC_SCALE_KW.test(t));
    palette = isScale ? _AC_8A : _AC_8B;
  } else if (n === 11) {
    palette = _AC_11;
  } else {
    return null;
  }

  return choices.map((label, i) => ({ label, color: palette[i] }));
}

/**
 * AppState.questions の中で、step3QuestionSettings に valueColorMapping が
 * まだ設定されていない設問に対して自動カラーを適用する。
 * 保存済みカラーは上書きしない。
 */
function _applyAutoColorsIfUnset() {
  const questions = AppState.questions ?? [];
  if (!questions.length) return;

  // グローバルフォールバック（step3QuestionSettings）への適用
  const next = { ...AppState.step3QuestionSettings };
  let changed = false;
  for (const q of questions) {
    const code = q.question_code;
    if (!code) continue;
    if (next[code]?.valueColorMapping?.length) continue; // 保存済みをスキップ
    const mapping = computeAutoColorMapping(q);
    if (mapping) {
      next[code] = { ...(next[code] ?? {}), valueColorMapping: mapping };
      changed = true;
    }
  }
  if (changed) AppState.step3QuestionSettings = next;

  // 各ビューの questionSettings にも自動カラーを適用。
  // _s3QS は ?? でビューが優先されるため、ビューに entry があるとグローバルの
  // オートカラーに届かない。ビュー側にも書き込むことで確実に反映する。
  const views = AppState.step3Views ?? {};
  if (!Object.keys(views).length) return;
  let viewsChanged = false;
  const nextViews = { ...views };
  for (const [viewId, view] of Object.entries(views)) {
    const viewQS = view.questionSettings ?? {};
    let viewChanged = false;
    const nextViewQS = { ...viewQS };
    for (const q of questions) {
      const code = q.question_code;
      if (!code) continue;
      if (nextViewQS[code]?.valueColorMapping?.length) continue; // 保存済みカラーはスキップ
      const mapping = computeAutoColorMapping(q);
      if (mapping) {
        nextViewQS[code] = { ...(nextViewQS[code] ?? {}), valueColorMapping: mapping };
        viewChanged = true;
      }
    }
    if (viewChanged) {
      nextViews[viewId] = { ...view, questionSettings: nextViewQS };
      viewsChanged = true;
    }
  }
  if (viewsChanged) AppState.step3Views = nextViews;
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
  step2BracketColumns: [],    // MA展開列情報（bracket_columns）
  // STEP2 FA 永続化
  step2SelectedFaCodes: [],
  // プロジェクト管理
  projectName: "",
  projectSavedAt: null,   // Date | null
  isDirty: false,
  // STEP1 カラー設定
  step1AxisColors: {},  // { axis_question_code: { fixedPalette: string | null } }
  // ユーザー生成パレット
  userPalettes: {},  // { [paletteId]: UserPaletteEntry }
  // STEP3
  step3CrosstabConfigs: [],
  step3ActiveAxisCode: "",
  step3LastGeneratedAxisCode: "",
  step3QuestionSettings: {},  // { question_code: QuestionSettings } — 旧形式フォールバック用
  step3SecondaryAxisCode: "",
  step3CompositeDisplayMode: "split",   // "nested" | "flat" | "split"
  step3ColorPriority: "axis1",          // "axis1" | "axis2" | "auto"
  step3MinSampleSize: 0,
  step3TargetFilterColumn: "",   // 分析対象列 (question_code or "")
  step3TargetFilterValues: [],   // 分析対象値 (string[])
  // STEP3 分析モード（新UI）
  step3Mode: "brand_comparison",           // "brand_comparison" | "deep_dive" | "attribute" | "fan" | "average"
  step3BasicAxisCode: "",                   // 基本軸 question_code
  step3ComparisonAxisCode: "",              // 比較軸 question_code (optional)
  step3DeepDiveTarget: "",                  // 特定対象深掘りの対象値
  step3SelectedQuestionCodes: [],           // 集計対象設問（明示選択分）
  // STEP3 特定分析: 属性分析
  step3AttrSimpleCodes: [],        // 単純集計対象の属性設問コード
  step3AttrCrossPairs: [],         // [{rowCode, colCode}]
  // STEP3 特定分析: ファン度分析
  step3FanDegreeType: "auto",      // "auto" | "new" | "old" | "custom"
  step3FanRowCode: "",              // 行（縦軸）設問コード: 好意度 等
  step3FanColCode: "",              // 列（横軸）設問コード: 応援意向/ファンステージ 等
  step3FanMatrix: [],               // [{rowValue, colValue, label}]
  step3FanDenominatorMode: "valid", // "all" | "valid" | "excluding_undetermined" | "filtered"
  step3FanFilterColumn: "",         // denominator_mode==="filtered" のときの絞り込み列
  step3FanFilterValues: [],
  // STEP3 特定分析: 平均点分析
  step3AvgTargets: [],             // [{code, scaleSettings:{...}, choiceScores:[...]}]
  step3SavedIndicators: [],        // 通常分析で使う平均点指標 QuestionItem[]（question_type==="SCORE"）
  step3AvgIndicatorCodes: [],      // 通常分析で現在選択中の平均点指標コード string[]
  step3AvgTriMatrix: {},           // { [question_code]: [{score, label}, ...] } — 3区分判定マトリクス
  // STEP3 集計ビュー
  step3Views: {},         // { [viewId]: ViewRecord } — viewId = `${axisCode}||${secAxisCode}`
  step3ActiveViewId: "",  // 現在アクティブなビューのID
  // 設問セット
  questionSets: [],      // QuestionSet[] — { setId, setName, questionCodes, isCustom }
  step3ActiveSetId: "",  // STEP3 で現在選択中のセットID
  // 設問分類
  hiddenQuestionTypes: ["OA_AUX", "FLAG", "DERIVED"],  // STEP3 で初期非表示にする question_type
  // 分析対象
  excludedQuestionCodes: [],  // 分析対象 OFF（STEP3 集計・分析セット候補から除外）の設問コード
  // レポート生成（設定フォームの一時状態）
  reportMode: "comparison",           // "comparison" | "single"
  reportTargetColumn: "",             // 分析対象列 (question_code)
  reportTargetValues: [],             // 選択された対象値
  reportSelectedQuestions: [],        // 分析設問コード
  reportAxisSpecs: [],                // [{type, column_code}]
  reportPages: [],                    // 生成済みページデータ（廃止予定・後方互換）
  reportLoading: false,
  // レポートプロジェクト（プロジェクト保存に統合）
  reportProject: {
    projectId: "",
    pages: [],           // ReportProjectPage[]
    activePageId: null,  // 現在プレビュー中のページID
  },
  reportMainMode: "settings",  // "settings" | "preview"
  chartResults: [],            // ChartResult[] — STEP3集計結果をSTEP4で参照
  // ファイル形式設定
  layoutFormat: "auto",      // "auto" | "intage" | "questant" — STEP1 でのユーザー選択（ヒント）
  responseFormat: "auto",    // "auto" | "intage" | "questant" — 後方互換用（参照は surveyFormat を使う）
  surveyFormat: "unknown",   // "intage" | "questant" | "unknown" — STEP1 で確定したプロジェクト全体の調査形式
};

function _makeViewId(axisCode, secAxisCode) {
  return `${axisCode || ""}||${secAxisCode || ""}`;
}

function _ensureView(axisCode, secAxisCode) {
  const viewId = _makeViewId(axisCode, secAxisCode);
  if (!AppState.step3Views[viewId]) {
    AppState.step3Views = {
      ...AppState.step3Views,
      [viewId]: {
        viewId,
        axisCode: axisCode ?? "",
        secAxisCode: secAxisCode ?? "",
        questionSettings: {},
        createdAt: new Date().toISOString(),
      },
    };
    _applyAutoColorsIfUnset();
  }
  AppState.step3ActiveViewId = viewId;
  return viewId;
}

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
  _ensureView(code, AppState.step3SecondaryAxisCode);
  AppState.isDirty = true;
  _emit();
}

export function setStep3SecondaryAxis(code) {
  AppState.step3SecondaryAxisCode = code ?? "";
  _ensureView(AppState.step3ActiveAxisCode, code);
  AppState.isDirty = true;
  _emit();
}

export function setStep3CompositeDisplayMode(mode) {
  AppState.step3CompositeDisplayMode = mode ?? "split";
  AppState.isDirty = true;
  _emit();
}

export function setStep3ColorPriority(priority) {
  AppState.step3ColorPriority = priority ?? "axis1";
  AppState.isDirty = true;
  _emit();
}

export function setStep3MinSampleSize(n) {
  AppState.step3MinSampleSize = typeof n === "number" ? n : (parseInt(n, 10) || 0);
  AppState.isDirty = true;
  _emit();
}

export function setQuestionSets(sets) {
  AppState.questionSets = Array.isArray(sets) ? [...sets] : [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3ActiveSetId(id) {
  AppState.step3ActiveSetId = id ?? "";
  _emit();
}

export function setStep3Setting(questionCode, key, value) {
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views[viewId];
  if (view) {
    const existing = view.questionSettings[questionCode] ?? {};
    AppState.step3Views = {
      ...AppState.step3Views,
      [viewId]: {
        ...view,
        questionSettings: {
          ...view.questionSettings,
          [questionCode]: { ...existing, [key]: value },
        },
      },
    };
  } else {
    const existing = AppState.step3QuestionSettings[questionCode] ?? {};
    AppState.step3QuestionSettings = {
      ...AppState.step3QuestionSettings,
      [questionCode]: { ...existing, [key]: value },
    };
  }
  AppState.isDirty = true;
  _emit();
}

export function setStep3SettingsBulk(updates) {
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views[viewId];
  if (view) {
    const nextQS = { ...view.questionSettings };
    for (const [qCode, partial] of Object.entries(updates)) {
      nextQS[qCode] = { ...(nextQS[qCode] ?? {}), ...partial };
    }
    AppState.step3Views = {
      ...AppState.step3Views,
      [viewId]: { ...view, questionSettings: nextQS },
    };
  } else {
    const next = { ...AppState.step3QuestionSettings };
    for (const [qCode, partial] of Object.entries(updates)) {
      next[qCode] = { ...(next[qCode] ?? {}), ...partial };
    }
    AppState.step3QuestionSettings = next;
  }
  AppState.isDirty = true;
  _emit();
}

export function setStep3ActiveViewId(viewId) {
  const view = AppState.step3Views[viewId];
  if (!view) return;
  AppState.step3ActiveViewId = viewId;
  AppState.step3ActiveAxisCode = view.axisCode;
  AppState.step3SecondaryAxisCode = view.secAxisCode;
  AppState.isDirty = true;
  _emit();
}

export function renameStep3View(viewId, newName) {
  const view = AppState.step3Views[viewId];
  if (!view) return;
  AppState.step3Views = { ...AppState.step3Views, [viewId]: { ...view, name: newName } };
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

export function addUserPalette(entry) {
  AppState.userPalettes = {
    ...AppState.userPalettes,
    [entry.paletteId]: entry,
  };
  AppState.isDirty = true;
  _emit();
}

export function deleteUserPalette(paletteId) {
  const next = { ...AppState.userPalettes };
  delete next[paletteId];
  AppState.userPalettes = next;
  AppState.isDirty = true;
  _emit();
}

export function clearQuestionColorState(questionCode) {
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views[viewId];
  if (view) {
    const { selectedPalette, overriddenSeriesColors, customColors, valueColorMapping, ...rest } =
      view.questionSettings[questionCode] ?? {};
    AppState.step3Views = {
      ...AppState.step3Views,
      [viewId]: { ...view, questionSettings: { ...view.questionSettings, [questionCode]: rest } },
    };
  } else {
    const { selectedPalette, overriddenSeriesColors, customColors, valueColorMapping, ...rest } =
      AppState.step3QuestionSettings[questionCode] ?? {};
    AppState.step3QuestionSettings = {
      ...AppState.step3QuestionSettings,
      [questionCode]: rest,
    };
  }
  AppState.isDirty = true;
  _emit();
}

export function clearQuestionColorStateBulk(questionCodes) {
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views[viewId];
  if (view) {
    const nextQS = { ...view.questionSettings };
    for (const qCode of questionCodes) {
      const { selectedPalette, overriddenSeriesColors, customColors, valueColorMapping, ...rest } = nextQS[qCode] ?? {};
      nextQS[qCode] = rest;
    }
    AppState.step3Views = {
      ...AppState.step3Views,
      [viewId]: { ...view, questionSettings: nextQS },
    };
  } else {
    const next = { ...AppState.step3QuestionSettings };
    for (const qCode of questionCodes) {
      const { selectedPalette, overriddenSeriesColors, customColors, valueColorMapping, ...rest } = next[qCode] ?? {};
      next[qCode] = rest;
    }
    AppState.step3QuestionSettings = next;
  }
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
  AppState.layoutFormat    = resp.format_hint ?? "auto";
  AppState.surveyFormat    = resp.survey_format ?? "unknown";
  AppState.excludedQuestionCodes = _deriveExcludedDefaults(AppState.questions);
  AppState.isDirty               = true;
  _applyAutoColorsIfUnset();
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
  AppState.choiceColumnMode = layout.choice_column_mode ?? "";
  AppState.layoutFormat    = resp.layout_format ?? layout.layout_format ?? "auto";
  AppState.responseFormat  = resp.response_format ?? layout.response_format ?? "auto";
  AppState.surveyFormat    = resp.survey_format ?? "unknown";

  if (resp.step2) {
    const s2 = resp.step2;
    // Parquet あり（通常復元）または Parquet なし（メタデータのみ）どちらも共通で復元する
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
    AppState.step2BracketColumns      = s2.bracket_columns ?? [];
    // プレビュー行は保存対象外
    AppState.step2PreviewRows         = [];
    AppState.step2LabeledPreviewRows  = [];
  }

  AppState.step3CrosstabConfigs = resp.step3_crosstab_configs ?? [];
  AppState.step3ActiveAxisCode = resp.step3_active_axis_code ?? "";
  AppState.step3LastGeneratedAxisCode = "";
  AppState.step3SecondaryAxisCode    = resp.layout?.step3_secondary_axis_code ?? "";
  AppState.step3Mode             = resp.layout?.step3_mode             ?? "brand_comparison";
  AppState.step3BasicAxisCode    = resp.layout?.step3_basic_axis_code    ?? "";
  AppState.step3ComparisonAxisCode = resp.layout?.step3_comparison_axis_code ?? "";
  AppState.step3DeepDiveTarget   = resp.layout?.step3_deep_dive_target   ?? "";
  AppState.step3CompositeDisplayMode = resp.layout?.step3_composite_display_mode ?? "split";
  AppState.step3ColorPriority        = resp.layout?.step3_color_priority ?? "axis1";
  AppState.step3MinSampleSize        = resp.layout?.step3_min_sample_size ?? 0;
  AppState.step3TargetFilterColumn   = resp.layout?.step3_target_filter_column ?? "";
  AppState.step3TargetFilterValues   = resp.layout?.step3_target_filter_values ?? [];
  AppState.questionSets   = (resp.layout?.question_sets ?? []).map(s => {
    const isCustom = s.isCustom === true || (typeof s.setId === "string" && s.setId.startsWith("custom_"));
    if (!isCustom) return { ...s, isCustom: false };
    // 旧フラット型カスタムセット（isParent なし + questionCodes あり + children なし）を親子構造へマイグレーション
    if (!s.isParent && (s.questionCodes?.length ?? 0) > 0 && !(s.children?.length)) {
      return {
        ...s, isCustom: true, isParent: true, questionCodes: [],
        children: [{ setId: s.setId + "_ch0", setName: "（未分類）", questionCodes: s.questionCodes ?? [] }],
      };
    }
    return { ...s, isCustom };
  });
  AppState.step3ActiveSetId = "";
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
  AppState.userPalettes    = resp.layout?.user_palettes ?? {};
  // 設問分類: 保存済みがあれば復元、なければデフォルト
  AppState.hiddenQuestionTypes = resp.layout?.hidden_question_types?.length
    ? resp.layout.hidden_question_types
    : ["OA_AUX", "FLAG", "DERIVED"];
  // 分析対象: 保存済みがあれば復元、なければ question_type から自動初期化
  AppState.excludedQuestionCodes = resp.layout?.excluded_questions?.length
    ? resp.layout.excluded_questions
    : _deriveExcludedDefaults(AppState.questions);
  // 集計ビューのロード + マイグレーション
  AppState.step3Views = resp.layout?.step3_views ?? {};
  if (!Object.keys(AppState.step3Views).length) {
    // 旧形式: step3_question_settings があれば保存軸のビューとして移行
    const axisCode  = AppState.step3ActiveAxisCode;
    const secAxisCode = AppState.step3SecondaryAxisCode;
    if (axisCode && Object.keys(AppState.step3QuestionSettings).length) {
      const viewId = _makeViewId(axisCode, secAxisCode);
      AppState.step3Views = {
        [viewId]: {
          viewId, axisCode, secAxisCode,
          questionSettings: AppState.step3QuestionSettings,
          createdAt: new Date().toISOString(),
        },
      };
    }
  }
  // アクティブビューIDを復元（basicAxis||compAxis が最も安定）
  AppState.step3ActiveViewId = _makeViewId(
    AppState.step3BasicAxisCode || AppState.step3ActiveAxisCode,
    AppState.step3ComparisonAxisCode || AppState.step3SecondaryAxisCode,
  );
  AppState.chartResults = resp.layout?.chart_results ?? [];
  // 平均点分析: スコア設定・マッピングの復元
  {
    const savedScaleSettings = resp.layout?.score_settings ?? {};
    const savedScoreMapping  = resp.layout?.score_mapping  ?? {};
    AppState.step3AvgTargets = Object.keys(savedScaleSettings).map(code => ({
      code,
      scaleSettings: savedScaleSettings[code],
      choiceScores:  savedScoreMapping[code] ?? [],
    }));
  }
  // ファン度分析: 判定方式・設問選択・マトリクス等の復元
  {
    const fd = resp.layout?.fan_degree_settings ?? {};
    AppState.step3FanDegreeType      = fd.fanDegreeType ?? "auto";
    AppState.step3FanRowCode         = fd.rowCode ?? "";
    AppState.step3FanColCode         = fd.colCode ?? "";
    // 旧仕様で保存された「非ファン」は表記揺れになるため復元時に「未ファン」へ統一する
    AppState.step3FanMatrix          = (fd.matrix ?? []).map(c => (
      c.label === "非ファン" ? { ...c, label: "未ファン" } : c
    ));
    AppState.step3FanDenominatorMode = fd.denominatorMode ?? "valid";
    AppState.step3FanFilterColumn    = fd.filterColumn ?? "";
    AppState.step3FanFilterValues    = fd.filterValues ?? [];
  }
  // 平均点分析: 3区分判定マトリクスの復元
  AppState.step3AvgTriMatrix = resp.layout?.avg_tri_matrix ?? {};
  // 属性分析: 単純集計対象・クロスペアの復元
  {
    const attr = resp.layout?.attr_settings ?? {};
    AppState.step3AttrSimpleCodes = attr.attrSimpleCodes ?? [];
    AppState.step3AttrCrossPairs  = attr.attrCrossPairs  ?? [];
  }
  _applyAutoColorsIfUnset();
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


export function setExcludedQuestionCodes(codes) {
  AppState.excludedQuestionCodes = Array.isArray(codes) ? [...codes] : [];
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
  AppState.step2SelectedFaCodes = [];
  AppState.projectName     = "";
  AppState.projectSavedAt  = null;
  AppState.isDirty         = false;
  AppState.step3CrosstabConfigs = [];
  AppState.step3ActiveAxisCode = "";
  AppState.step3LastGeneratedAxisCode = "";
  AppState.step3QuestionSettings = {};
  AppState.step3Views            = {};
  AppState.step3ActiveViewId     = "";
  AppState.userPalettes = {};
  AppState.questionSets          = [];
  AppState.step3ActiveSetId      = "";
  AppState.hiddenQuestionTypes   = ["OA_AUX", "FLAG", "DERIVED"];
  AppState.excludedQuestionCodes = [];
  AppState.step3TargetFilterColumn = "";
  AppState.step3TargetFilterValues = [];
  AppState.step3Mode                  = "brand_comparison";
  AppState.step3BasicAxisCode         = "";
  AppState.step3ComparisonAxisCode    = "";
  AppState.step3DeepDiveTarget        = "";
  AppState.step3SelectedQuestionCodes = [];
  AppState.step3AttrSimpleCodes       = [];
  AppState.step3AttrCrossPairs        = [];
  AppState.step3FanDegreeType         = "auto";
  AppState.step3FanRowCode            = "";
  AppState.step3FanColCode            = "";
  AppState.step3FanMatrix             = [];
  AppState.step3FanDenominatorMode    = "valid";
  AppState.step3FanFilterColumn       = "";
  AppState.step3FanFilterValues       = [];
  AppState.step3AvgTargets            = [];
  AppState.step3SavedIndicators       = [];
  AppState.step3AvgIndicatorCodes     = [];
  AppState.step3AvgTriMatrix          = {};
  AppState.reportMode              = "comparison";
  AppState.reportTargetColumn      = "";
  AppState.reportTargetValues      = [];
  AppState.reportSelectedQuestions = [];
  AppState.reportAxisSpecs         = [];
  AppState.reportPages             = [];
  AppState.reportLoading           = false;
  AppState.reportProject           = { projectId: "", pages: [], activePageId: null };
  AppState.reportMainMode          = "settings";
  AppState.chartResults            = [];
  AppState.layoutFormat            = "auto";
  AppState.responseFormat          = "auto";
  AppState.surveyFormat            = "unknown";
  _emit();
}

export function setStep3TargetFilterColumn(code) {
  AppState.step3TargetFilterColumn = code ?? "";
  AppState.step3TargetFilterValues = [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3TargetFilterValues(values) {
  AppState.step3TargetFilterValues = Array.isArray(values) ? [...values] : [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3Mode(mode) {
  AppState.step3Mode = mode ?? "brand_comparison";
  AppState.isDirty = true;
  _emit();
}

export function setStep3BasicAxis(code) {
  AppState.step3BasicAxisCode = code ?? "";
  AppState.step3ActiveAxisCode = code ?? "";
  _ensureView(code, AppState.step3ComparisonAxisCode);
  AppState.isDirty = true;
  _emit();
}

export function setStep3ComparisonAxis(code) {
  AppState.step3ComparisonAxisCode = code ?? "";
  AppState.step3SecondaryAxisCode = code ?? "";
  _ensureView(AppState.step3BasicAxisCode, code);
  AppState.isDirty = true;
  _emit();
}

export function setStep3DeepDiveTarget(value) {
  AppState.step3DeepDiveTarget = value ?? "";
  AppState.isDirty = true;
  _emit();
}

export function setStep3SelectedQuestionCodes(codes) {
  AppState.step3SelectedQuestionCodes = Array.isArray(codes) ? [...codes] : [];
  AppState.isDirty = true;
  _emit();
}

// ---------------------------------------------------------------------------
// STEP3 特定分析: 属性分析
// ---------------------------------------------------------------------------

export function setStep3AttrSimpleCodes(codes) {
  AppState.step3AttrSimpleCodes = Array.isArray(codes) ? [...codes] : [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3AttrCrossPairs(pairs) {
  AppState.step3AttrCrossPairs = Array.isArray(pairs) ? [...pairs] : [];
  AppState.isDirty = true;
  _emit();
}

// ---------------------------------------------------------------------------
// STEP3 特定分析: ファン度分析
// ---------------------------------------------------------------------------

export function setStep3FanDegreeType(type) {
  AppState.step3FanDegreeType = type ?? "auto";
  AppState.isDirty = true;
  _emit();
}

export function setStep3FanRowCode(code) {
  AppState.step3FanRowCode = code ?? "";
  AppState.isDirty = true;
  _emit();
}

export function setStep3FanColCode(code) {
  AppState.step3FanColCode = code ?? "";
  AppState.isDirty = true;
  _emit();
}

export function setStep3FanMatrix(matrix) {
  AppState.step3FanMatrix = Array.isArray(matrix) ? [...matrix] : [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3FanDenominatorMode(mode) {
  AppState.step3FanDenominatorMode = mode ?? "valid";
  AppState.isDirty = true;
  _emit();
}

export function setStep3FanFilterColumn(code) {
  AppState.step3FanFilterColumn = code ?? "";
  AppState.step3FanFilterValues = [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3FanFilterValues(values) {
  AppState.step3FanFilterValues = Array.isArray(values) ? [...values] : [];
  AppState.isDirty = true;
  _emit();
}

/**
 * 特定分析から「通常分析で使う軸・指標」を追加したあとに呼ぶ。
 * question_type === "SCORE" は平均点指標として step3SavedIndicators へ、
 * それ以外（"DERIVED" 等）はクロス集計軸として step2AxisCandidates へ追加する。
 */
export function addDerivedAxisQuestions(questionItems) {
  if (!Array.isArray(questionItems) || !questionItems.length) return;
  const newCodes = new Set(questionItems.map(q => q.question_code));

  AppState.questions = [
    ...(AppState.questions ?? []).filter(q => !newCodes.has(q.question_code)),
    ...questionItems,
  ];

  const axisItems = questionItems.filter(q => (q.question_type ?? "") !== "SCORE");
  const scoreItems = questionItems.filter(q => (q.question_type ?? "") === "SCORE");

  if (axisItems.length) {
    const newCandidates = axisItems.map(q => ({
      question_code: q.question_code,
      question_text: q.question_text,
      type_code: q.type_code,
      type_label: q.type_label,
      is_default_selected: true,
    }));
    AppState.step2AxisCandidates = [
      ...(AppState.step2AxisCandidates ?? []).filter(c => !newCodes.has(c.question_code)),
      ...newCandidates,
    ];
  }

  if (scoreItems.length) {
    const scoreCodes = new Set(scoreItems.map(q => q.question_code));
    AppState.step3SavedIndicators = [
      ...(AppState.step3SavedIndicators ?? []).filter(q => !scoreCodes.has(q.question_code)),
      ...scoreItems,
    ];
    // 平均点指標も軸候補に追加（基本軸・比較軸ドロップダウンで選択可能にする）
    const scoreAxisCandidates = scoreItems.map(q => ({
      question_code: q.question_code,
      question_text: q.question_text,
      type_code: q.type_code,
      type_label: q.type_label,
      is_default_selected: false,
    }));
    AppState.step2AxisCandidates = [
      ...(AppState.step2AxisCandidates ?? []).filter(c => !scoreCodes.has(c.question_code)),
      ...scoreAxisCandidates,
    ];
  }

  AppState.step2MatchedColumns = [
    ...new Set([...(AppState.step2MatchedColumns ?? []), ...newCodes]),
  ];

  _emit();
}

/** 平均点指標を1件追加する（save-as-indicator 成功後に呼ぶ）。 */
export function addSavedIndicator(questionItem) {
  if (!questionItem) return;
  addDerivedAxisQuestions([questionItem]);
}

// ---------------------------------------------------------------------------
// STEP3 特定分析: 平均点分析
// ---------------------------------------------------------------------------

export function setStep3AvgTargets(targets) {
  AppState.step3AvgTargets = Array.isArray(targets) ? [...targets] : [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3AvgIndicatorCodes(codes) {
  AppState.step3AvgIndicatorCodes = Array.isArray(codes) ? [...codes] : [];
  AppState.isDirty = true;
  _emit();
}

export function setStep3AvgTriMatrix(code, matrix) {
  AppState.step3AvgTriMatrix = { ...AppState.step3AvgTriMatrix, [code]: matrix };
  AppState.isDirty = true;
  _emit();
}

/** 指定 question_code の選択肢テキスト一覧を返す（STEP3 / STEP4 共通）。 */
export function getTargetValues(code) {
  if (!code) return [];
  const q = (AppState.questions ?? []).find(q => q.question_code === code);
  return (q?.choices ?? []).map(c => c.choice_text).filter(Boolean);
}

export function addChartResults(newResults) {
  const existing = [...AppState.chartResults];
  for (const r of newResults) {
    const idx = existing.findIndex(e => e.id === r.id);
    if (idx >= 0) existing[idx] = r;
    else existing.push(r);
  }
  AppState.chartResults = existing;
  AppState.isDirty = true;
  _emit();
}

export function removeChartResult(id) {
  AppState.chartResults = AppState.chartResults.filter(r => r.id !== id);
  AppState.isDirty = true;
  _emit();
}

function _deriveChartMode(cr, s3) {
  const chartType = s3.chartType ?? "bar";
  const orient    = s3.orientation ?? "v";
  const hasComp   = Array.isArray(cr.comparison_datasets) && cr.comparison_datasets.length > 0;
  if (chartType === "stacked100") return orient === "h" ? "stacked100_hbar" : "stacked100_vbar";
  if (chartType === "grouped")    return orient === "h" ? "grouped_hbar"    : "grouped_vbar";
  if (chartType === "bar") {
    if (hasComp) return orient === "h" ? "brand_hbar" : "brand_vbar";
    return orient === "h" ? "hbar" : "vbar";
  }
  return "auto";  // pie, line, radar, scatter, avg_bar, table_only
}

function _buildDefaultTitle(cr) {
  let title = `${cr.question_text ?? cr.question_code} × ${cr.axis_label ?? cr.axis_code}`;
  if (cr.secondary_axis_label || cr.secondary_axis_code) {
    title += ` × ${cr.secondary_axis_label ?? cr.secondary_axis_code}`;
  }
  if (cr.target_filter_column && cr.target_filter_values?.length) {
    title += ` [${cr.target_filter_column}: ${cr.target_filter_values.join("・")}]`;
  }
  return title;
}

function _buildAggregationConfig(cr) {
  return {
    chartResultId: cr.id,
    questionCode:  cr.question_code,
    axisCode:      cr.axis_code      ?? "",
    secAxisCode:   cr.secondary_axis_code ?? "",
    filterColumn:  cr.target_filter_column  ?? "",
    filterValues:  [...(cr.target_filter_values ?? [])],
  };
}

function _buildChartConfig(cr, s3) {
  const chartMode = _deriveChartMode(cr, s3);
  // stacked100/grouped は STEP3で X軸=axis_categories、凡例=rows として描画するため
  // STEP4でも同じ向きにするために transpose: true が必要
  const needsAutoTranspose = chartMode.startsWith("stacked100") || chartMode.startsWith("grouped");
  return {
    chartMode,
    aggMode:            s3.aggMode          ?? "col_pct",
    sortOrder:          s3.sortOrder        ?? "original",
    transpose:          needsAutoTranspose ? true : (s3.transpose ?? false),
    hiddenChoices:      [...(s3.hiddenChoices ?? [])],
    showLabels:         s3.showPctLabel     ?? true,
    showLegend:         true,
    legendPosition:     "bottom",
    labelDecimalPlaces: 1,
    labelMinPercent:    2,
    barThickness:       s3.barWidth         ?? null,
    chartHeightPx:      s3.chartHeight      ?? null,
    chartWidthPx:       null,
    splitMode:          s3.splitMode        ?? "normal",
    splitColumns:       s3.splitColumns     ?? null,
    itemsPerPage:       s3.itemsPerPage     ?? null,
    pageLayout:         s3.pageLayout       ?? "auto",
    showTotalCol:       s3.showTotalCol     ?? true,
    colorSettings: {
      // undefined(未設定) と null(明示的グレー) を区別するため ?? null を使わない
      ...(s3.selectedPalette !== undefined ? { selectedPalette: s3.selectedPalette } : {}),
      valueColorMapping:      s3.valueColorMapping      ?? null,
      overriddenSeriesColors: { ...(s3.overriddenSeriesColors ?? {}) },
      resolvedColorMap:       s3.resolvedColorMap        ?? null,
    },
  };
}

function _defaultLayoutConfig() {
  return {
    titleOverride: null, questionTextOverride: null, showQuestionText: true,
    subtitleFontSize: 8,
    chartHeightPx: null, chartWidthPx: null, chartMaxWidthPx: null,
    categoryPercentage: 0.8, barPercentage: 0.9,
    axisFontSize: 8, labelFontSize: 8, legendFontSize: 6,
    labelAnchor: "center", labelAlign: "center",
    showTable: false, tableContentMode: "percent",
    showTableRowTotal: false, showTableColTotal: false,
    tableFontSize: 9, tableDecimalPlaces: 1, tableCellPadding: null,
    rowChoiceOrder: null,  // null=STEP1順、string[]=手動並び替え順
  };
}

function _buildReportPage(cr, s3) {
  const lc = _defaultLayoutConfig();
  if ((s3.chartType ?? "bar") === "table_only") lc.showTable = true;
  lc.titleOverride = _buildDefaultTitle(cr);
  return {
    id: _uuid(),
    aggregationConfig: _buildAggregationConfig(cr),
    chartConfig:       _buildChartConfig(cr, s3),
    layoutConfig:      lc,
  };
}

// 分割モードで生成される仮想データセット数を求める
function _calcVirtualDatasetCount(cr, splitMode) {
  if (splitMode === "by_axis")       return (cr.axis_categories ?? []).length;
  if (splitMode === "by_comparison") return (cr.rows ?? []).length;
  return 0;
}

// 1ページあたりのアイテム数（explicitIpp=null なら pageLayout から自動推定）
function _resolveItemsPerPage(pageLayout, explicitIpp) {
  if (explicitIpp) return explicitIpp;
  if (pageLayout === "grid3x2") return 6;
  if (pageLayout === "grid2x2") return 4;
  if (pageLayout === "cols3")   return 6;
  if (pageLayout === "cols2")   return 4;
  if (pageLayout === "cols1")   return 2;
  return 4; // auto / vertical
}

// total を size ごとに chunk 化（[{start, end}] の配列）
function _chunksOf(total, size) {
  const chunks = [];
  for (let start = 0; start < total; start += size) {
    chunks.push({ start, end: Math.min(start + size, total) });
  }
  return chunks.length > 0 ? chunks : [{ start: 0, end: 0 }];
}

// STEP3→STEP4 ページ追加（type_code 依存デフォルト込みの s3 settings を受け取る）
export function addReportPageFromStep3(cr, s3) {
  const splitMode = s3.splitMode ?? "normal";

  if (splitMode === "normal") {
    const newPage = _buildReportPage(cr, s3);
    AppState.reportProject = {
      ...AppState.reportProject,
      pages: [...AppState.reportProject.pages, newPage],
      activePageId: newPage.id,
    };
    AppState.isDirty = true;
    _emit();
    return;
  }

  // 分割モード: 自動ページ分割
  const totalItems   = _calcVirtualDatasetCount(cr, splitMode);
  const pageLayout   = s3.pageLayout   ?? "auto";
  const itemsPerPage = _resolveItemsPerPage(pageLayout, s3.itemsPerPage ?? null);
  const chunks       = _chunksOf(totalItems, itemsPerPage);
  const baseTitle    = _buildDefaultTitle(cr);

  // デバッグログ: ページ分割の概要を出力
  console.group(`[STEP4追加] splitMode=${splitMode} "${cr.question_code}"`);
  console.log(`  STEP3グラフ数: ${totalItems}`);
  console.log(`  件/ページ: ${itemsPerPage}  配置: ${pageLayout}  → ${chunks.length}ページ`);
  chunks.forEach((c, i) =>
    console.log(`  ページ${i + 1}: チャート${c.start + 1}〜${c.end} (${c.end - c.start}件)`)
  );
  const totalAcrossPages = chunks.reduce((sum, c) => sum + (c.end - c.start), 0);
  if (totalAcrossPages !== totalItems) {
    console.warn(`  ⚠️ 合計不一致！ STEP3=${totalItems}件 vs ページ合計=${totalAcrossPages}件`);
  } else {
    console.log(`  ✅ 合計一致: ${totalItems}件`);
  }
  console.groupEnd();

  const allIndices = Array.from({ length: totalItems }, (_, i) => i);

  const newPages = chunks.map((chunk, chunkIdx) => {
    const lc = _defaultLayoutConfig();
    if ((s3.chartType ?? "bar") === "table_only") lc.showTable = true;
    lc.titleOverride = chunks.length > 1
      ? `${baseTitle}（${chunkIdx + 1}/${chunks.length}）`
      : baseTitle;
    return {
      id: _uuid(),
      aggregationConfig: _buildAggregationConfig(cr),
      chartConfig: {
        ..._buildChartConfig(cr, s3),
        splitDatasetIndices: allIndices.slice(chunk.start, chunk.end),
        pageLayout,
        itemsPerPage,
      },
      layoutConfig: lc,
    };
  });

  const firstId = newPages[0]?.id ?? AppState.reportProject.activePageId;
  AppState.reportProject = {
    ...AppState.reportProject,
    pages: [...AppState.reportProject.pages, ...newPages],
    activePageId: firstId,
  };
  AppState.isDirty = true;
  _emit();
}

// 既存ページを STEP3 最新状態で上書き（layoutConfig は保持）
export function overwriteReportPageFromStep3(pageId, cr, s3) {
  AppState.reportProject = {
    ...AppState.reportProject,
    pages: AppState.reportProject.pages.map(p => {
      const pid = p.id ?? p.pageId;
      if (pid !== pageId) return p;
      return {
        ...p,
        aggregationConfig: _buildAggregationConfig(cr),
        chartConfig: _buildChartConfig(cr, s3),
        // layoutConfig は保持
      };
    }),
    activePageId: pageId,
  };
  AppState.isDirty = true;
  _emit();
}

// 同一 chartResultId のページを探す（重複検出）
export function findDuplicateReportPage(chartResultId) {
  return AppState.reportProject.pages.find(p =>
    (p.aggregationConfig?.chartResultId ?? p.chartResultId) === chartResultId
  ) ?? null;
}

// 同一 chartResultId を持つ分割ページを全取得（splitMode != "normal"）
export function getSplitGroupPages(chartResultId) {
  return AppState.reportProject.pages.filter(p =>
    (p.aggregationConfig?.chartResultId ?? p.chartResultId) === chartResultId &&
    (p.chartConfig?.splitMode ?? "normal") !== "normal"
  );
}

// 自動再配置: visibleIndices を itemsPerPage/pageLayout で再分配しページを更新
// hiddenIndices: 非表示として維持したい index 配列
export function reflowSplitPages(chartResultId, itemsPerPage, pageLayout, hiddenIndices = []) {
  const groupPages = getSplitGroupPages(chartResultId);
  if (!groupPages.length) return;

  const first = groupPages[0];
  const cr = AppState.chartResults.find(r => r.id === chartResultId);
  const total = _calcVirtualDatasetCount(cr, first.chartConfig?.splitMode ?? "normal");
  const hiddenSet = new Set(hiddenIndices);
  const visibleIndices = Array.from({ length: total }, (_, i) => i).filter(i => !hiddenSet.has(i));

  const resolvedIpp = _resolveItemsPerPage(pageLayout, itemsPerPage);
  const chunks = _chunksOf(visibleIndices.length, resolvedIpp);
  const rawTitle = first.layoutConfig?.titleOverride ?? "";
  const baseTitle = rawTitle.replace(/（\d+\/\d+）$/, "");

  const newPages = chunks.map((chunk, i) => {
    const existing = groupPages[i];
    const base = existing ?? first;
    return {
      ...base,
      id: existing?.id ?? _uuid(),
      chartConfig: {
        ...(base.chartConfig ?? {}),
        splitDatasetIndices: visibleIndices.slice(chunk.start, chunk.end),
        pageLayout,
        itemsPerPage,
      },
      layoutConfig: {
        ...(base.layoutConfig ?? {}),
        titleOverride: chunks.length > 1 ? `${baseTitle}（${i + 1}/${chunks.length}）` : baseTitle,
      },
    };
  });

  const allPages   = AppState.reportProject.pages;
  const firstIdx   = allPages.findIndex(p => _pid(p) === _pid(groupPages[0]));
  const groupIdSet = new Set(groupPages.map(p => _pid(p)));
  const nonGroup   = allPages.filter(p => !groupIdSet.has(_pid(p)));
  const updatedPages = [
    ...nonGroup.slice(0, firstIdx),
    ...newPages,
    ...nonGroup.slice(firstIdx),
  ];

  AppState.reportProject = {
    ...AppState.reportProject,
    pages: updatedPages,
    activePageId: newPages[0]?.id ?? AppState.reportProject.activePageId,
  };
  AppState.isDirty = true;
  _emit();
}

// グラフを同ページ内で移動（dir: -1=上, +1=下）
function _moveSplitGraphWithin(dsIndex, pageId, dir) {
  const page = AppState.reportProject.pages.find(p => _pid(p) === pageId);
  if (!page) return;
  const indices = [...(page.chartConfig?.splitDatasetIndices ?? [])];
  const pos  = indices.indexOf(dsIndex);
  if (pos < 0) return;
  const swap = pos + dir;
  if (swap < 0 || swap >= indices.length) return;
  [indices[pos], indices[swap]] = [indices[swap], indices[pos]];
  updateReportProjectPage(pageId, { chartConfig: { ...page.chartConfig, splitDatasetIndices: indices } });
}

export function moveSplitGraphUp(dsIndex, pageId) {
  _moveSplitGraphWithin(dsIndex, pageId, -1);
}

export function moveSplitGraphDown(dsIndex, pageId) {
  _moveSplitGraphWithin(dsIndex, pageId, +1);
}

// グラフを前/次ページへ移動（dir: -1=前, +1=次）
export function moveSplitGraphToAdjacentPage(dsIndex, fromPageId, dir) {
  const fromPage = AppState.reportProject.pages.find(p => _pid(p) === fromPageId);
  if (!fromPage) return;
  const chartResultId = fromPage.aggregationConfig?.chartResultId ?? fromPage.chartResultId;
  const groupPages = getSplitGroupPages(chartResultId);
  const fromIdx = groupPages.findIndex(p => _pid(p) === fromPageId);
  const toIdx   = fromIdx + dir;
  if (toIdx < 0 || toIdx >= groupPages.length) return;

  const toPage     = groupPages[toIdx];
  const fromIndices = (fromPage.chartConfig?.splitDatasetIndices ?? []).filter(i => i !== dsIndex);
  const toIndices   = dir === -1
    ? [...(toPage.chartConfig?.splitDatasetIndices ?? []), dsIndex]
    : [dsIndex, ...(toPage.chartConfig?.splitDatasetIndices ?? [])];

  updateReportProjectPage(_pid(fromPage), { chartConfig: { ...fromPage.chartConfig, splitDatasetIndices: fromIndices } });
  updateReportProjectPage(_pid(toPage),   { chartConfig: { ...toPage.chartConfig,   splitDatasetIndices: toIndices   } });

  // 空になったページを削除
  if (fromIndices.length === 0) {
    const pages = AppState.reportProject.pages.filter(p => _pid(p) !== _pid(fromPage));
    AppState.reportProject = { ...AppState.reportProject, pages };
    AppState.isDirty = true;
    _emit();
  }
}

// グラフの表示/非表示切り替え（非表示 = どのページにも含めない）
export function toggleSplitGraphVisibility(dsIndex, chartResultId) {
  const groupPages = getSplitGroupPages(chartResultId);
  const isVisible  = groupPages.some(p =>
    (p.chartConfig?.splitDatasetIndices ?? []).includes(dsIndex)
  );

  if (isVisible) {
    groupPages.forEach(p => {
      const newIndices = (p.chartConfig?.splitDatasetIndices ?? []).filter(i => i !== dsIndex);
      updateReportProjectPage(_pid(p), { chartConfig: { ...p.chartConfig, splitDatasetIndices: newIndices } });
    });
  } else {
    // 最後のページの末尾に追加
    const lastPage = groupPages[groupPages.length - 1];
    if (lastPage) {
      const newIndices = [...(lastPage.chartConfig?.splitDatasetIndices ?? []), dsIndex];
      updateReportProjectPage(_pid(lastPage), { chartConfig: { ...lastPage.chartConfig, splitDatasetIndices: newIndices } });
    }
  }
}

// 旧フロー（report.js _onGenerate 経由）互換 — raw s3 settings で動作
// colorMapFn: (cr) => {label: hex} を返す任意コールバック（report.js から渡す）
export function addChartResultsAsReportPages(chartResults, colorMapFn = null) {
  const _s3View = AppState.step3Views[AppState.step3ActiveViewId];
  const _s3QS = qCode =>
    _s3View?.questionSettings?.[qCode] ?? AppState.step3QuestionSettings?.[qCode] ?? {};
  const newPages = (chartResults ?? []).map(cr => {
    const s3raw = _s3QS(cr.question_code);
    const resolvedColorMap = colorMapFn ? colorMapFn(cr) : null;
    return _buildReportPage(cr, resolvedColorMap ? { ...s3raw, resolvedColorMap } : s3raw);
  });
  const allPages = [...AppState.reportProject.pages, ...newPages];
  const lastId = newPages.length > 0 ? newPages[newPages.length - 1].id : AppState.reportProject.activePageId;
  AppState.reportProject = { ...AppState.reportProject, pages: allPages, activePageId: lastId };
  AppState.isDirty = true;
  _emit();
}

export function setReportMode(mode) {
  AppState.reportMode = mode ?? "comparison";
  _emit();
}

export function setReportTargetColumn(code) {
  AppState.reportTargetColumn = code ?? "";
  AppState.reportTargetValues = [];
  _emit();
}

export function setReportTargetValues(values) {
  AppState.reportTargetValues = Array.isArray(values) ? [...values] : [];
  _emit();
}

export function setReportSelectedQuestions(codes) {
  AppState.reportSelectedQuestions = Array.isArray(codes) ? [...codes] : [];
  _emit();
}

export function setReportAxisSpecs(specs) {
  AppState.reportAxisSpecs = Array.isArray(specs) ? [...specs] : [];
  _emit();
}

export function setReportPages(pages) {
  AppState.reportPages = Array.isArray(pages) ? [...pages] : [];
  _emit();
}

export function setReportLoading(loading) {
  AppState.reportLoading = !!loading;
  _emit();
}

function _uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function setReportProject(project) {
  AppState.reportProject = project ?? { projectId: "", pages: [], activePageId: null };
  _emit();
}

export function setReportProjectFromLoad(data) {
  if (!data) return;
  AppState.reportProject = {
    projectId: data.projectId ?? AppState.reportProject.projectId,
    pages: data.pages ?? [],
    activePageId: data.activePageId ?? null,
  };
  if (data.reportMode) AppState.reportMode = data.reportMode;
  if (data.reportTargetColumn != null) AppState.reportTargetColumn = data.reportTargetColumn;
  if (Array.isArray(data.reportTargetValues)) AppState.reportTargetValues = data.reportTargetValues;
  if (Array.isArray(data.reportSelectedQuestions)) AppState.reportSelectedQuestions = data.reportSelectedQuestions;
  if (Array.isArray(data.reportAxisSpecs)) AppState.reportAxisSpecs = data.reportAxisSpecs;
  if (data.activePageId) AppState.reportMainMode = "preview";
  _emit();
}

export function addReportProjectPages(apiPages) {
  // STEP3 のアクティブビューから色設定を取得（ページ生成時にコピー）
  const _s3View = AppState.step3Views[AppState.step3ActiveViewId];
  const _s3QS = (qCode) =>
    _s3View?.questionSettings?.[qCode] ?? AppState.step3QuestionSettings?.[qCode] ?? {};

  const newPages = (apiPages ?? []).map(p => {
    const s3 = _s3QS(p.question_code);
    return {
      pageId: p.page_id || _uuid(),
      title: p.title,
      mode: p.mode,
      targetColumn: AppState.reportTargetColumn,
      targetValues: [...AppState.reportTargetValues],
      questionCode: p.question_code,
      axisSpec: p.axis_code ? { type: "column", column_code: p.axis_code } : { type: "total", column_code: "" },
      chartSettings: {
        titleOverride: null,
        questionTextOverride: null,
        showQuestionText: true,
        chartMode: "auto",
        showLabels: true,
        labelDecimalPlaces: 1,
        showLegend: true,
        legendPosition: "bottom",
        showTable: false,
        chartHeightPx: null,
        barThickness: null,
        categoryPercentage: 0.8,
        barPercentage: 0.9,
        axisFontSize: 10,
        labelFontSize: 10,
        legendFontSize: 11,
        labelMinPercent: 2,
        labelAnchor: "center",
        labelAlign: "center",
        colorSettings: {
          selectedPalette: s3.selectedPalette ?? null,
          valueColorMapping: s3.valueColorMapping ?? null,
          overriddenSeriesColors: {},
        },
      },
      generatedData: p,
    };
  });
  const allPages = [...AppState.reportProject.pages, ...newPages];
  const lastId = newPages.length > 0 ? newPages[newPages.length - 1].pageId : AppState.reportProject.activePageId;
  AppState.reportProject = { ...AppState.reportProject, pages: allPages, activePageId: lastId };
  AppState.isDirty = true;
  _emit();
}

const _pid = p => p.id ?? p.pageId;

export function updateReportProjectPage(pageId, patch) {
  AppState.reportProject = {
    ...AppState.reportProject,
    pages: AppState.reportProject.pages.map(p => _pid(p) === pageId ? { ...p, ...patch } : p),
  };
  AppState.isDirty = true;
  _emit();
}

export function removeReportProjectPage(pageId) {
  const pages = AppState.reportProject.pages.filter(p => _pid(p) !== pageId);
  let activePageId = AppState.reportProject.activePageId;
  if (activePageId === pageId) {
    activePageId = pages.length > 0 ? _pid(pages[pages.length - 1]) : null;
  }
  AppState.reportProject = { ...AppState.reportProject, pages, activePageId };
  AppState.isDirty = true;
  _emit();
}

export function duplicateReportProjectPage(pageId) {
  const src = AppState.reportProject.pages.find(p => _pid(p) === pageId);
  if (!src) return;
  const newId = _uuid();
  const clone = { ...src, id: newId, pageId: undefined };
  const idx = AppState.reportProject.pages.findIndex(p => _pid(p) === pageId);
  const pages = [
    ...AppState.reportProject.pages.slice(0, idx + 1),
    clone,
    ...AppState.reportProject.pages.slice(idx + 1),
  ];
  AppState.reportProject = { ...AppState.reportProject, pages, activePageId: newId };
  AppState.isDirty = true;
  _emit();
}

export function setActiveReportPageId(pageId) {
  AppState.reportProject = { ...AppState.reportProject, activePageId: pageId };
  _emit();
}

export function setReportMainMode(mode) {
  AppState.reportMainMode = mode ?? "settings";
  _emit();
}

export function addReportPagesFromConfig(pages) {
  if (!pages?.length) return;
  const allPages = [...AppState.reportProject.pages, ...pages];
  const lastId = pages[pages.length - 1].pageId;
  AppState.reportProject = { ...AppState.reportProject, pages: allPages, activePageId: lastId };
  AppState.isDirty = true;
  _emit();
}

export function reorderReportPage(pageId, direction) {
  const pages = [...AppState.reportProject.pages];
  const idx = pages.findIndex(p => p.pageId === pageId);
  if (idx < 0) return;
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= pages.length) return;
  [pages[idx], pages[targetIdx]] = [pages[targetIdx], pages[idx]];
  AppState.reportProject = { ...AppState.reportProject, pages };
  AppState.isDirty = true;
  _emit();
}

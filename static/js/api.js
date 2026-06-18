/**
 * API fetch ラッパー。全エンドポイントをここに集約する。
 */

const BASE = "/api";

/** レイアウト CSV をアップロードする。 */
export async function uploadFile(file, formatHint = "auto") {
  const form = new FormData();
  form.append("file", file);
  form.append("format_hint", formatHint);
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "アップロードに失敗しました。");
  }
  return res.json();
}

/** 形式ヒントを変えてレイアウトを再解析する。 */
export async function reparseLayout(sessionToken, formatHint) {
  const res = await fetch(`${BASE}/upload/reparse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken, format_hint: formatHint }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "再解析に失敗しました。");
  }
  return res.json();
}

/** 手動マッピングでレイアウト CSV を再パースする。 */
export async function remapUpload(sessionToken, colMapping) {
  const res = await fetch(`${BASE}/upload/remap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: sessionToken, col_mapping: colMapping }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "マッピングの適用に失敗しました。");
  }
  return res.json();
}

/** 設問一覧を取得する（検索・フィルタ付き）。 */
export async function getQuestions(token, { search = "", typeFilter = "", includeChildren = true } = {}) {
  const params = new URLSearchParams({ session_token: token });
  if (search)         params.set("search", search);
  if (typeFilter)     params.set("type_filter", typeFilter);
  params.set("include_children", includeChildren ? "true" : "false");
  const res = await fetch(`${BASE}/questions?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "設問一覧の取得に失敗しました。");
  }
  return res.json();
}

/** 内部データ全量 JSON を取得する（デバッグ用）。 */
export async function getQuestionsJson(token) {
  const params = new URLSearchParams({ session_token: token });
  const res = await fetch(`${BASE}/questions/json?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "JSON の取得に失敗しました。");
  }
  return res.json();
}

/** プロジェクト (.surveyproject) をダウンロードする。 */
export async function saveProject(token, projectName = "", step3QuestionSettings = {}, step1AxisColors = {}, userPalettes = {}, compositeSettings = {}, questionSets = [], step3CrosstabCache = {}, hiddenQuestionTypes = [], excludedQuestions = [], step3Views = {}, reportProject = {}, chartResults = [], layoutFormat = "auto", responseFormat = "auto", surveyFormat = "unknown", scoreSettings = {}, scoreMapping = {}, fanDegreeSettings = {}, attrSettings = {}, avgTriMatrix = {}) {
  const res = await fetch(`${BASE}/project/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: token,
      project_name: projectName,
      step3_question_settings: step3QuestionSettings,
      step1_axis_colors: step1AxisColors,
      user_palettes: userPalettes,
      step3_mode: compositeSettings.mode ?? "brand_comparison",
      step3_basic_axis_code: compositeSettings.basicAxisCode ?? "",
      step3_comparison_axis_code: compositeSettings.compAxisCode ?? "",
      step3_deep_dive_target: compositeSettings.deepDiveTarget ?? "",
      step3_secondary_axis_code: compositeSettings.secondaryAxisCode ?? "",
      step3_composite_display_mode: compositeSettings.displayMode ?? "split",
      step3_color_priority: compositeSettings.colorPriority ?? "axis1",
      step3_min_sample_size: compositeSettings.minSampleSize ?? 0,
      step3_target_filter_column: compositeSettings.targetFilterColumn ?? "",
      step3_target_filter_values: compositeSettings.targetFilterValues ?? [],
      question_sets: questionSets,
      step3_crosstab_cache: step3CrosstabCache,
      hidden_question_types: hiddenQuestionTypes,
      excluded_questions: excludedQuestions,
      step3_views: step3Views,
      report_project: reportProject,
      chart_results: chartResults,
      layout_format: layoutFormat,
      response_format: responseFormat,
      survey_format: surveyFormat,
      score_settings: scoreSettings,
      score_mapping: scoreMapping,
      fan_degree_settings: fanDegreeSettings,
      attr_settings: attrSettings,
      avg_tri_matrix: avgTriMatrix,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "保存に失敗しました。");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename\*=UTF-8''([^;\r\n]+)/i)
             ?? cd.match(/filename="?([^";\r\n]+)"?/i);
  const filename = match ? decodeURIComponent(match[1]) : `${projectName || "project"}.surveyproject`;
  console.log("[SHOW SAVE DIALOG]", filename);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log("[WRITE FILE]", filename);
}

/** プロジェクトファイル (.surv または .json) を復元する。 */
export async function loadProject(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/project/load`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "プロジェクトの読み込みに失敗しました。");
  }
  return res.json();
}


/** FA 設問選択と属性列選択をサーバーキャッシュに保存する。 */
export async function saveFaSettings(token, faCodes, attrCols) {
  const res = await fetch(`${BASE}/step2/fa/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: token,
      selected_fa_codes: faCodes,
      selected_attr_columns: attrCols,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "FA 設定の保存に失敗しました。");
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// STEP2: 回答データ読込・ラベル変換
// ---------------------------------------------------------------------------

/** 回答データ CSV / xlsx をアップロードしてラベル変換結果を取得する。 */
export async function uploadResponseFile(file, sessionToken, { signal, responseFormat = "auto" } = {}) {
  const form = new FormData();
  form.append("file", file);
  form.append("session_token", sessionToken);
  form.append("response_format", responseFormat);
  const res = await fetch(`${BASE}/step2/upload`, { method: "POST", body: form, signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "回答データのアップロードに失敗しました。");
  }
  return res.json();
}

/** STEP2 アップロード進捗をポーリングする。 */
export async function getStep2Progress(sessionToken) {
  const res = await fetch(`${BASE}/step2/progress/${encodeURIComponent(sessionToken)}`);
  if (!res.ok) return null;
  return res.json();
}

/** 手動照合ルールを適用し、ラベル変換済みデータを更新する。 */
export async function applyManualMatch(token, rules) {
  const res = await fetch(`${BASE}/step2/manual-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: token, rules }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "手動照合の適用に失敗しました。");
  }
  return res.json();
}

/** 変換不可値に手動ラベルを割り当てる。fixes: [{question_code, raw_value, label}] */
export async function applyLabelFix(token, fixes) {
  const res = await fetch(`${BASE}/step2/label-fix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: token, fixes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "ラベル修正の適用に失敗しました。");
  }
  return res.json();
}

/** STEP2 の現在の状態を取得する。 */
export async function getStep2State(token) {
  const params = new URLSearchParams({ session_token: token });
  const res = await fetch(`${BASE}/step2/state?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "STEP2 状態の取得に失敗しました。");
  }
  return res.json();
}

/** 集計軸の選択を保存する。 */
export async function saveStep2Axis(token, selectedColumns) {
  const res = await fetch(`${BASE}/step2/axis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_token: token, selected_axis_columns: selectedColumns }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "集計軸の保存に失敗しました。");
  }
  return res.json();
}

/** FA閲覧メタ情報（設問リスト・属性候補）のみ取得する。行データは含まれない。 */
export async function getFaMeta(token) {
  const params = new URLSearchParams({ session_token: token });
  const res = await fetch(`${BASE}/step2/fa/meta?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "FA メタ情報の取得に失敗しました。");
  }
  return res.json();
}

/** FA閲覧データを取得する。 */
export async function getFaData(token, {
  attrColumns = [],
  faCodes = [],
  excludeEmpty = true,
  minChars = 0,
  sortBy = "response_order",
  sortAttr = "",
  keyword = "",
} = {}) {
  const params = new URLSearchParams({ session_token: token });
  if (attrColumns.length)  params.set("attr_columns", attrColumns.join(","));
  if (faCodes.length)      params.set("fa_codes", faCodes.join(","));
  params.set("exclude_empty", excludeEmpty ? "true" : "false");
  params.set("min_chars", String(minChars));
  params.set("sort_by", sortBy);
  if (sortAttr)  params.set("sort_attr", sortAttr);
  if (keyword)   params.set("keyword", keyword);
  const res = await fetch(`${BASE}/step2/fa?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "FA データの取得に失敗しました。");
  }
  return res.json();
}

/** FA データをエクスポートする（CSV または Excel）。 */
export async function exportFaData(token, {
  attrColumns = [],
  faCodes = [],
  excludeEmpty = true,
  minChars = 0,
  sortBy = "response_order",
  sortAttr = "",
  keyword = "",
  format = "csv",
} = {}) {
  const params = new URLSearchParams({ session_token: token });
  if (attrColumns.length)  params.set("attr_columns", attrColumns.join(","));
  if (faCodes.length)      params.set("fa_codes", faCodes.join(","));
  params.set("exclude_empty", excludeEmpty ? "true" : "false");
  params.set("min_chars", String(minChars));
  params.set("sort_by", sortBy);
  if (sortAttr)  params.set("sort_attr", sortAttr);
  if (keyword)   params.set("keyword", keyword);
  params.set("format", format);
  const res = await fetch(`${BASE}/step2/fa/export?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "FA エクスポートに失敗しました。");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : `fa_export.${format === "excel" ? "xlsx" : "csv"}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// STEP3: クロス集計
// ---------------------------------------------------------------------------

/** クロス集計を実行する。 */
export async function generateCrosstab(sessionToken, axisCode, secondaryAxisCode = "", targetCodes = [], targetFilterColumn = "", targetFilterValues = [], avgIndicatorCodes = []) {
  const res = await fetch(`${BASE}/step3/crosstab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      axis_question_code: axisCode,
      secondary_axis_question_code: secondaryAxisCode,
      target_question_codes: targetCodes,
      target_filter_column: targetFilterColumn,
      target_filter_values: targetFilterValues,
      avg_indicator_codes: avgIndicatorCodes,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "クロス集計に失敗しました。");
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// STEP3: 特定分析（属性分析・ファン度分析・平均点分析）
// ---------------------------------------------------------------------------

async function _postSpecialAnalysis(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "分析の実行に失敗しました。");
  }
  return res.json();
}

/** 属性分析（単純集計＋クロス集計）を実行する。 */
export async function generateAttributeAnalysis(sessionToken, simpleTallyCodes = [], crossPairs = []) {
  return _postSpecialAnalysis("/step3/special/attribute", {
    session_token: sessionToken,
    simple_tally_codes: simpleTallyCodes,
    cross_pairs: crossPairs.map(p => ({ row_code: p.rowCode, col_code: p.colCode })),
  });
}

/** ファン度分析を実行する（新ファン度/旧ファン度/カスタム共通の汎用マトリクス方式）。常に全体集計のみを返す。 */
export async function generateFanAnalysis(sessionToken, fanDegreeType, rowCode, colCode, matrix = [], denominatorMode = "valid", filterColumn = "", filterValues = []) {
  return _postSpecialAnalysis("/step3/special/fan", {
    session_token: sessionToken,
    fan_degree_type: fanDegreeType,
    row_question_code: rowCode,
    col_question_code: colCode,
    matrix: matrix.map(c => ({ row_value: c.rowValue, col_value: c.colValue, label: c.label })),
    denominator_mode: denominatorMode,
    target_filter_column: filterColumn,
    target_filter_values: filterValues,
  });
}

/**
 * ファン度判定結果（fan_degree_label/各種フラグ）を通常分析用の派生属性として保存する。
 * すでに同じfan_degree_typeで保存済み・overwrite=falseの場合は409エラーを投げる
 * （呼び出し側でエラーの.statusを見て上書き確認→overwrite=trueで再送する想定）。
 */
export async function saveFanDegreeAsAxis(sessionToken, fanDegreeType, rowCode, colCode, matrix = [], overwrite = false) {
  const res = await fetch(`${BASE}/step3/special/fan/save-as-axis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      fan_degree_type: fanDegreeType,
      row_question_code: rowCode,
      col_question_code: colCode,
      matrix: matrix.map(c => ({ row_value: c.rowValue, col_value: c.colValue, label: c.label })),
      overwrite,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error = new Error(err.detail ?? "ファン度の保存に失敗しました。");
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** ファン度分析結果をExcel (.xlsx) として出力する。fanAnalysisResponseは直前のgenerateFanAnalysis()の戻り値。 */
export async function exportFanAnalysis(fanAnalysisResponse) {
  const res = await fetch(`${BASE}/step3/special/fan/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fanAnalysisResponse),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "ファン度分析のエクスポートに失敗しました。");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename\*=UTF-8''([^;\r\n]+)/i) ?? cd.match(/filename="?([^";\r\n]+)"?/i);
  const filename = match ? decodeURIComponent(match[1]) : "fan_degree.xlsx";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 平均点分析を実行する（全体統計のみ）。 */
export async function generateAverageAnalysis(sessionToken, targets = []) {
  return _postSpecialAnalysis("/step3/special/average", {
    session_token: sessionToken,
    targets: targets.map(t => ({
      question_code: t.code,
      scale_settings: {
        data_min_score: t.scaleSettings.dataMin,
        data_max_score: t.scaleSettings.dataMax,
        display_min_score: t.scaleSettings.displayMin,
        display_max_score: t.scaleSettings.displayMax,
        scale_direction: t.scaleSettings.direction,
        calc_method: t.scaleSettings.calcMethod,
      },
      choice_scores: t.choiceScores.map(c => ({
        choice_text: c.choiceText,
        raw_score: c.rawScore,
        converted_score: c.convertedScore,
        manual_score: c.manualScore,
        final_score: c.finalScore,
        exclude_flag: c.excludeFlag,
        missing_flag: c.missingFlag,
      })),
    })),
  });
}

/** 平均点指標を通常分析用の数値指標として保存する。 */
export async function saveAverageAsIndicator(sessionToken, target, indicatorName, overwrite = false) {
  const res = await fetch(`${BASE}/step3/special/average/save-as-indicator`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      question_code: target.code,
      scale_settings: {
        data_min_score: target.scaleSettings.dataMin,
        data_max_score: target.scaleSettings.dataMax,
        display_min_score: target.scaleSettings.displayMin,
        display_max_score: target.scaleSettings.displayMax,
        scale_direction: target.scaleSettings.direction,
        calc_method: target.scaleSettings.calcMethod,
      },
      choice_scores: target.choiceScores.map(c => ({
        choice_text: c.choiceText,
        raw_score: c.rawScore,
        converted_score: c.convertedScore,
        manual_score: c.manualScore,
        final_score: c.finalScore,
        exclude_flag: c.excludeFlag,
        missing_flag: c.missingFlag,
      })),
      indicator_name: indicatorName,
      overwrite,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error = new Error(err.detail ?? "平均点指標の保存に失敗しました。");
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** 入力点数ラベル・3区分ラベルを DERIVED 派生軸として保存する。 */
export async function saveAverageAsDerived(sessionToken, questionCode, baseName, choiceScores, triMatrix, overwrite = false) {
  const res = await fetch(`${BASE}/step3/special/average/save-as-derived`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      question_code: questionCode,
      base_name: baseName,
      choice_scores: choiceScores.map(c => ({
        choice_text: c.choiceText,
        raw_score: c.rawScore,
        converted_score: c.convertedScore,
        manual_score: c.manualScore,
        final_score: c.finalScore,
        exclude_flag: c.excludeFlag,
        missing_flag: c.missingFlag,
      })),
      tri_matrix: triMatrix,
      overwrite,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error = new Error(err.detail ?? "派生項目の保存に失敗しました。");
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** 属性クロスペアを通常分析用の派生軸として保存する。 */
export async function saveAttributeAsAxis(sessionToken, rowCode, colCode, axisName, overwrite = false) {
  const res = await fetch(`${BASE}/step3/special/attribute/save-as-axis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      row_code: rowCode,
      col_code: colCode,
      axis_name: axisName,
      overwrite,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error = new Error(err.detail ?? "属性軸の保存に失敗しました。");
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** ラベル変換済みデータを CSV としてダウンロードする。 */
export async function exportLabeledData(token) {
  const params = new URLSearchParams({ session_token: token });
  const res = await fetch(`${BASE}/step2/export?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "エクスポートに失敗しました。");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : "labeled_data.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// STEP3 エクスポート
// ---------------------------------------------------------------------------

function _triggerBlobDownload(blob, cd, fallback) {
  const match = cd.match(/filename\*=UTF-8''([^;\r\n]+)/i)
             ?? cd.match(/filename="?([^";\r\n]+)"?/i);
  const filename = match ? decodeURIComponent(match[1]) : fallback;
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

/** クロス集計結果を Excel ファイルとしてダウンロードする。 */
export async function exportCrosstabExcel(payload) {
  const res = await fetch(`${BASE}/step3/export/excel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Excel エクスポートに失敗しました。");
  }
  _triggerBlobDownload(await res.blob(), res.headers.get("Content-Disposition") ?? "", "crosstab.xlsx");
}

/** クロス集計結果を CSV / ZIP としてダウンロードする。 */
export async function exportCrosstabCsv(payload, { single = false, questionCode = "" } = {}) {
  const params = new URLSearchParams();
  if (single)       params.set("single", "true");
  if (questionCode) params.set("question_code", questionCode);
  const qs = params.toString();
  const res = await fetch(`${BASE}/step3/export/csv${qs ? "?" + qs : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "CSV エクスポートに失敗しました。");
  }
  _triggerBlobDownload(await res.blob(), res.headers.get("Content-Disposition") ?? "", single ? "crosstab.csv" : "crosstab.zip");
}

/** レポートを PowerPoint (.pptx) としてダウンロードする。 */
export async function exportReportPptx(pages, chartResults) {
  const res = await fetch(`${BASE}/report/export/pptx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages, chart_results: chartResults }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "PowerPoint 出力に失敗しました。");
  }
  // 件数検証ヘッダーを確認してフロントエンドに返す
  const warning = res.headers.get("X-Split-Charts-Warning");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "report.pptx";
  a.click();
  URL.revokeObjectURL(url);
  // 件数不一致があれば呼び出し元が受け取れるよう例外ではなくメッセージとして返す
  return warning ?? null;
}

/** レポートページを生成する。 */
export async function generateReport(sessionToken, mode, targetColumn, targetValues, questionCodes, axisSpecs) {
  const res = await fetch(`${BASE}/report/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      mode,
      target_column: targetColumn,
      target_values: targetValues,
      question_codes: questionCodes,
      axis_specs: axisSpecs,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "レポート生成に失敗しました。");
  }
  return res.json();
}

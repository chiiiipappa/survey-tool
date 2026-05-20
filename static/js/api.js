/**
 * API fetch ラッパー。全エンドポイントをここに集約する。
 */

const BASE = "/api";

/** レイアウト CSV をアップロードする。 */
export async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "アップロードに失敗しました。");
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

/** プロジェクト (.surv) をダウンロードする。 */
export async function saveProject(token, projectName = "", step3QuestionSettings = {}, step1AxisColors = {}, userPalettes = {}, compositeSettings = {}) {
  const res = await fetch(`${BASE}/project/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: token,
      project_name: projectName,
      step3_question_settings: step3QuestionSettings,
      step1_axis_colors: step1AxisColors,
      user_palettes: userPalettes,
      step3_secondary_axis_code: compositeSettings.secondaryAxisCode ?? "",
      step3_composite_display_mode: compositeSettings.displayMode ?? "split",
      step3_color_priority: compositeSettings.colorPriority ?? "axis1",
      step3_min_sample_size: compositeSettings.minSampleSize ?? 0,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "保存に失敗しました。");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : "survey_project.surv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

/** STEP1 の集計軸コードと STEP3 の選択軸をサーバーキャッシュに保存する。 */
export async function saveStep1AxisSettings(token, axisCodes, step3ActiveAxisCode = "") {
  const res = await fetch(`${BASE}/step1/axis/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: token,
      step1_axis_codes: axisCodes,
      step3_active_axis_code: step3ActiveAxisCode,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "集計軸設定の保存に失敗しました。");
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
export async function uploadResponseFile(file, sessionToken) {
  const form = new FormData();
  form.append("file", file);
  form.append("session_token", sessionToken);
  const res = await fetch(`${BASE}/step2/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "回答データのアップロードに失敗しました。");
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
export async function generateCrosstab(sessionToken, axisCode, secondaryAxisCode = "", targetCodes = []) {
  const res = await fetch(`${BASE}/step3/crosstab`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: sessionToken,
      axis_question_code: axisCode,
      secondary_axis_question_code: secondaryAxisCode,
      target_question_codes: targetCodes,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "クロス集計に失敗しました。");
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

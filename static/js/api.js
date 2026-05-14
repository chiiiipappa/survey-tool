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

/** プロジェクト JSON をダウンロードする。 */
export async function saveProject(token) {
  const params = new URLSearchParams({ session_token: token });
  const res = await fetch(`${BASE}/project/save?${params}`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "保存に失敗しました。");
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") ?? "";
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : "survey_project.json";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** プロジェクト JSON ファイルを復元する。 */
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

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

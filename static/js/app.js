/**
 * エントリーポイント: ステップナビゲーション・グローバルユーティリティ。
 */
import { AppState, setActivePanel } from "./state.js";
import { initUploadPanel } from "./upload.js";
import { initQuestionsPanel, refreshQuestions } from "./questions.js";

// ---------------------------------------------------------------------------
// グローバルユーティリティ（他モジュールからインポートして使う）
// ---------------------------------------------------------------------------

export function showSpinner(msg = "処理中…") {
  document.getElementById("spinner-msg").textContent = msg;
  document.getElementById("spinner-overlay").classList.add("active");
}

export function hideSpinner() {
  document.getElementById("spinner-overlay").classList.remove("active");
}

export function showToast(msg, isError = false) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function showError(msg) {
  showToast(msg, true);
  console.error("[survey-tool]", msg);
}

// ---------------------------------------------------------------------------
// ステップナビゲーション
// ---------------------------------------------------------------------------

const PANELS = ["upload", "questions", "charts"];

function activatePanel(name) {
  PANELS.forEach((p) => {
    document.getElementById(`panel-${p}`)?.classList.toggle("active", p === name);
    document.getElementById(`btn-step-${p}`)?.classList.toggle("active", p === name);
  });
  setActivePanel(name);
  if (name === "questions") refreshQuestions();
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initUploadPanel();
  initQuestionsPanel();

  // ステップボタン
  document.getElementById("btn-step-upload").addEventListener("click", () => activatePanel("upload"));
  document.getElementById("btn-step-questions").addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("questions");
  });

  // アップロードパネルの「設問確認へ」ボタン
  document.getElementById("btn-to-questions").addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("questions");
  });

  // 初期状態でアップロードパネルをアクティブに
  activatePanel("upload");
});

/**
 * エントリーポイント: ステップナビゲーション・グローバルユーティリティ。
 */
import { AppState, setActivePanel } from "./state.js";
import { initUploadPanel } from "./upload.js";
import { initQuestionsPanel, refreshQuestions } from "./questions.js";
import { initStep2Panel } from "./step2.js";

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

const PANELS = ["upload", "questions", "step2"];

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
  initStep2Panel();

  // ステップボタン
  document.getElementById("btn-step-upload").addEventListener("click", () => activatePanel("upload"));
  document.getElementById("btn-step-questions").addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("questions");
  });
  document.getElementById("btn-step-step2").addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("step2");
  });

  // アップロードパネルの「設問確認へ」ボタン
  document.getElementById("btn-to-questions").addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("questions");
  });

  // 設問確認パネルの「回答データ読込へ」ボタン
  document.getElementById("btn-to-step2").addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("step2");
  });

  // セッショントークンが確定したら ② ③ を有効化する
  document.addEventListener("survey:statechange", () => {
    const hasSession = !!AppState.sessionToken;
    document.getElementById("btn-step-questions").disabled = !hasSession;
    document.getElementById("btn-step-step2").disabled = !hasSession;
    document.getElementById("btn-to-step2").disabled = !hasSession;
  });

  // 初期状態でアップロードパネルをアクティブに
  activatePanel("upload");
});

/**
 * エントリーポイント: ステップナビゲーション・グローバルユーティリティ。
 */
import { AppState, setActivePanel } from "./state.js";
import { initUploadPanel } from "./upload.js";
import { initQuestionsPanel, refreshQuestions } from "./questions.js";
import { initStep2Panel } from "./step2.js";
import { initStep3Panel } from "./step3.js";

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

const PANELS = ["upload", "questions", "step2", "step3"];

export function activatePanel(name) {
  PANELS.forEach((p) => {
    document.getElementById(`panel-${p}`)?.classList.toggle("active", p === name);
  });

  const step1Active = name === "upload" || name === "questions";
  document.getElementById("btn-step-step1")?.classList.toggle("active", step1Active);
  document.getElementById("btn-step-step2")?.classList.toggle("active", name === "step2");
  document.getElementById("btn-step-step3")?.classList.toggle("active", name === "step3");

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
  initStep3Panel();

  // ステップナビボタン
  document.getElementById("btn-step-step1")?.addEventListener("click", () => {
    activatePanel(AppState.sessionToken ? "questions" : "upload");
  });
  document.getElementById("btn-step-step2")?.addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("step2");
  });
  document.getElementById("btn-step-step3")?.addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("step3");
  });

  // パネル内ナビゲーションボタン
  document.getElementById("btn-to-questions")?.addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("questions");
  });
  document.getElementById("btn-to-step2")?.addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("step2");
  });
  document.getElementById("btn-to-step3")?.addEventListener("click", () => {
    if (AppState.sessionToken) activatePanel("step3");
  });

  // セッション確立後に ② ③ を有効化
  document.addEventListener("survey:statechange", () => {
    const hasSession = !!AppState.sessionToken;
    document.getElementById("btn-step-step2").disabled = !hasSession;
    document.getElementById("btn-step-step3").disabled = !hasSession;
    document.getElementById("btn-to-step2").disabled = !hasSession;
    document.getElementById("btn-to-questions").disabled = !hasSession;
  });

  activatePanel("upload");
});

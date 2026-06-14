/**
 * エントリーポイント: ステップナビゲーション・グローバルユーティリティ。
 */
import { AppState, setActivePanel } from "./state.js";
import { initUploadPanel } from "./upload.js";
import { initQuestionsPanel, refreshQuestions, initProjectHeader } from "./questions.js";
import { initStep2Panel } from "./step2.js";
import { initStep3Panel } from "./step3.js";

// ---------------------------------------------------------------------------
// グローバルユーティリティ（他モジュールからインポートして使う）
// ---------------------------------------------------------------------------

/** メインスレッドをブロックしないための yield。chunk処理の合間に呼ぶ。 */
export function yieldToMain() {
  if (typeof scheduler !== "undefined" && typeof scheduler.yield === "function") {
    return scheduler.yield();
  }
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// 進捗バー API
// ---------------------------------------------------------------------------

let _cancelCallback = null;

/**
 * 進捗オーバーレイを表示する。
 * @param {object} opts
 * @param {string}   opts.title      - タイトル文字列
 * @param {string[]} opts.steps      - ステップ名の配列
 * @param {boolean}  [opts.showCancel=false]
 * @param {Function} [opts.onCancel] - キャンセル時コールバック
 */
export function showProgress({ title = "処理中…", steps = [], showCancel = false, onCancel = null } = {}) {
  document.getElementById("spinner-msg").textContent = title;
  const barWrap = document.getElementById("progress-bar-wrap");
  if (barWrap) barWrap.style.display = steps.length > 0 ? "" : "none";

  const fill = document.getElementById("progress-bar-fill");
  if (fill) fill.style.width = "0%";
  const pct = document.getElementById("progress-pct");
  if (pct) pct.textContent = "0%";

  const stepsEl = document.getElementById("progress-steps");
  if (stepsEl) {
    stepsEl.innerHTML = steps.map((s, i) =>
      `<li id="progress-step-${i}" class="progress-step">${s}</li>`
    ).join("");
  }

  const cancelBtn = document.getElementById("progress-cancel-btn");
  if (cancelBtn) {
    cancelBtn.style.display = showCancel ? "" : "none";
    _cancelCallback = onCancel;
  }

  document.getElementById("spinner-overlay").classList.add("active");
}

/**
 * 進捗バーを更新する。
 * @param {number} pct       - 0〜100
 * @param {number} stepIndex - 現在のステップインデックス（-1 で変更なし）
 * @param {string} [msg]     - タイトル文字列（省略可）
 */
export function updateProgress(pct, stepIndex = -1, msg) {
  const fill = document.getElementById("progress-bar-fill");
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  const pctEl = document.getElementById("progress-pct");
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (msg) document.getElementById("spinner-msg").textContent = msg;

  if (stepIndex >= 0) {
    document.querySelectorAll(".progress-step").forEach((el, i) => {
      el.classList.toggle("progress-step-active", i === stepIndex);
      el.classList.toggle("progress-step-done", i < stepIndex);
    });
  }
}

/** 進捗オーバーレイを隠す。 */
export function hideProgress() {
  document.getElementById("spinner-overlay").classList.remove("active");
  _cancelCallback = null;
  const cancelBtn = document.getElementById("progress-cancel-btn");
  if (cancelBtn) cancelBtn.style.display = "none";
}

export function showSpinner(msg = "処理中…") {
  showProgress({ title: msg });
}

export function hideSpinner() {
  hideProgress();
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

const PANELS = ["upload", "questions", "step2", "step3", "report"];

export function activatePanel(name) {
  PANELS.forEach((p) => {
    document.getElementById(`panel-${p}`)?.classList.toggle("active", p === name);
  });

  const step1Active = name === "upload" || name === "questions";
  document.getElementById("btn-step-step1")?.classList.toggle("active", step1Active);
  document.getElementById("btn-step-step2")?.classList.toggle("active", name === "step2");
  document.getElementById("btn-step-step3")?.classList.toggle("active", name === "step3");
  document.getElementById("btn-step-report")?.classList.toggle("active", name === "report");

  setActivePanel(name);
  if (name === "questions") refreshQuestions();
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("progress-cancel-btn")?.addEventListener("click", () => {
    if (_cancelCallback) _cancelCallback();
    hideProgress();
  });

  initUploadPanel();
  initQuestionsPanel();
  initStep2Panel();
  initStep3Panel();
  initProjectHeader();

  // プロジェクト読込後のパネル遷移と STEP2 UI 復元
  document.addEventListener("survey:projectloaded", async (e) => {
    const resp = e.detail;
    activatePanel(resp.has_step2 ? "step2" : "questions");
    if (resp.has_step2) {
      const { restoreStep2FromState } = await import("./step2.js");
      restoreStep2FromState();
    }
  });

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
  document.getElementById("btn-step-report")?.addEventListener("click", () => {
    if (AppState.step2Filename) activatePanel("report");
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
    document.getElementById("btn-step-report").disabled = !AppState.step2Filename;
    document.getElementById("btn-to-step2").disabled = !hasSession;
    document.getElementById("btn-to-questions").disabled = !hasSession;
  });

  activatePanel("upload");
});

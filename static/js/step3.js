/**
 * STEP3: クロス集計・グラフ作成 パネル（プレースホルダー）。
 */
import { AppState } from "./state.js";

export function initStep3Panel() {
  document.addEventListener("survey:statechange", _render);
}

function _render() {
  if (AppState.activePanel !== "step3") return;

  const el = document.getElementById("step3-axis-display");
  if (!el) return;

  const codes = AppState.step1AxisCodes;
  if (!codes.length) {
    el.innerHTML = '<span class="text-sm text-muted">STEP1 で集計軸が選択されていません。</span>';
    return;
  }

  el.innerHTML = codes
    .map(code => `<span class="badge">${_esc(code)}</span>`)
    .join("");
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

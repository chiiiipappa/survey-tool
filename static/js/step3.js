/**
 * STEP3: クロス集計・グラフ作成パネル。
 *
 * 設問ごとに棒グラフ向き・%ラベル・ソート・折りたたみ・除外を設定可能。
 * 設定は AppState.step3QuestionSettings に保持してプロジェクト保存対象。
 */
import { AppState, setStep3ActiveAxis, setStep3Setting, setStep3SettingsBulk, setStep1FixedPalette, clearQuestionColorState, addUserPalette } from "./state.js";

import { generateCrosstab } from "./api.js";
import {
  exportSingleExcel, exportAllExcel,
  exportSingleCsv,   exportAllCsv,
  exportSinglePng,   exportAllPng,
  initStep3ExportBulkButtons,
} from "./step3_export.js";

// ---------------------------------------------------------------------------
// グラフ種別定義
// ---------------------------------------------------------------------------

const CHART_TYPES = [
  { id: "bar",        label: "棒グラフ" },
  { id: "stacked100", label: "100%積み上げ" },
  { id: "pie",        label: "円グラフ" },
  { id: "grouped",    label: "grouped棒" },
  { id: "line",       label: "折れ線" },
  { id: "radar",      label: "レーダー" },
  { id: "scatter",    label: "散布図" },
  { id: "avg_bar",    label: "平均棒" },
  { id: "table_only", label: "表のみ" },
];

const RECOMMENDED_CHART = {
  SA: "bar", S: "bar",
  MA: "bar", ML: "bar", M: "bar",
  NU: "avg_bar", N: "avg_bar",
};

// 推奨度: "recommended" | "available" | "not_recommended"
const _SA_SUIT = { bar:"recommended", pie:"recommended", stacked100:"available", grouped:"available",
                   line:"available", radar:"available", scatter:"not_recommended", avg_bar:"not_recommended", table_only:"available" };
const _MA_SUIT = { bar:"recommended", stacked100:"available",
                   pie:"not_recommended", grouped:"not_recommended", line:"not_recommended",
                   radar:"not_recommended", scatter:"not_recommended", avg_bar:"not_recommended", table_only:"available" };
const _NU_SUIT = { avg_bar:"recommended", table_only:"available", line:"available", scatter:"available",
                   bar:"not_recommended", stacked100:"not_recommended", pie:"not_recommended",
                   grouped:"not_recommended", radar:"not_recommended" };
const CHART_SUITABILITY = {
  SA: _SA_SUIT, S: _SA_SUIT,
  MA: _MA_SUIT, ML: _MA_SUIT, M: _MA_SUIT,
  NU: _NU_SUIT, N: _NU_SUIT,
};

function _chartSuitability(chartId, typeCode) {
  return (CHART_SUITABILITY[typeCode] ?? {})[chartId] ?? "available";
}

// 向き選択が有効なチャートタイプ
const ORIENTATION_TYPES = new Set(["bar", "stacked100", "grouped"]);

const COLORS = [
  "#4299E1", "#F6AD55", "#68D391", "#F687B3", "#9F7AEA",
  "#76E4F7", "#FC8181", "#B7EE8F", "#F6E05E", "#90CDF4",
];

// ---------------------------------------------------------------------------
// 色変換ユーティリティ（キーカラー → パレット生成用）
// ---------------------------------------------------------------------------

function _hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h, s, l];
}

function _hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// キーカラーを基準に N 色のパレットを生成
function _generatePaletteColors(keyHex, count, stepPct, pattern, finePct, satAdjPct) {
  const [h, s, l] = _hexToHsl(keyHex);
  const step = stepPct / 100;
  const fine = finePct / 100;
  const sAdj = Math.min(1, Math.max(0, s + satAdjPct / 100));
  const clampL = v => Math.min(0.95, Math.max(0.05, v));

  let lightnesses;
  if (pattern === "center") {
    const ci = Math.floor(count / 2);
    lightnesses = Array.from({ length: count }, (_, i) => clampL(l + (ci - i) * step + fine));
  } else if (pattern === "light_to_dark") {
    lightnesses = Array.from({ length: count }, (_, i) => clampL(l - i * step + fine));
  } else {
    lightnesses = Array.from({ length: count }, (_, i) => clampL(l - (count - 1 - i) * step + fine));
  }
  return lightnesses.map(lv => _hslToHex(h, sAdj, lv));
}

// ユーザーパレット ID から palette-like オブジェクトを返す（インデックスベース）
function _getUserPaletteObj(paletteId) {
  const entry = AppState.userPalettes?.[paletteId];
  if (!entry) return null;
  return {
    label: entry.paletteName,
    preview: entry.generatedColors,
    generatedColors: entry.generatedColors,
    colorFor: () => null,
  };
}

// ---------------------------------------------------------------------------
// 固定カラー（特定ラベルに常に適用）
// ---------------------------------------------------------------------------

const FIXED_COLORS_MAP = {
  "その他":             "#BFBFBF",
  "あてはまるものはない": "#BFBFBF",
  "全体":               "#676767",
};

function _fixedColorFor(label) {
  if (FIXED_COLORS_MAP[label]) return FIXED_COLORS_MAP[label];
  if (/^その他($|[（(・\/])/.test(label)) return "#BFBFBF";
  if (/あてはまるものはない/.test(label))  return "#BFBFBF";
  return null;
}

// ---------------------------------------------------------------------------
// 固定パレット（ラベルマッピングセット）
// ---------------------------------------------------------------------------

const FIXED_PALETTES = {
  fan_label: {
    label: "ファンラベル",
    preview: ["#FF5050","#FF9999","#FFCCCC","#BFBFBF"],
    colorFor(label) {
      if (/コアファン/.test(label))      return "#FF5050";
      if (/ライトファン/.test(label))    return "#FFCCCC";
      if (/ファン/.test(label))          return "#FF9999";
      if (/非ファン|その他/.test(label)) return "#BFBFBF";
      return null;
    },
  },
  gender: {
    label: "男女パレット",
    preview: ["#1D4ED8","#DB2777"],
    colorFor(label) {
      if (/^男($|性)/.test(label)) return "#1D4ED8";
      if (/^女($|性)/.test(label)) return "#DB2777";
      return null;
    },
  },
  age_gender: {
    label: "性年代パレット",
    preview: ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A","#FBCFE8","#F9A8D4","#F472B6","#EC4899","#DB2777","#9D174D"],
    colorFor(label) {
      const m = label.match(/(\d+)代(男性|女性)/);
      if (!m) return null;
      const d = parseInt(m[1]);
      const male   = {10:"#BFDBFE",20:"#93C5FD",30:"#60A5FA",40:"#3B82F6",50:"#1D4ED8",60:"#1E3A8A"};
      const female = {10:"#FBCFE8",20:"#F9A8D4",30:"#F472B6",40:"#EC4899",50:"#DB2777",60:"#9D174D"};
      return (m[2] === "男性" ? male : female)[d] ?? null;
    },
  },
  age_a: {
    label: "年代別パレットA",
    preview: ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
    colorFor(label) {
      const m = label.match(/(\d+)代/);
      if (!m) return null;
      const map = {10:"#BFDBFE",20:"#93C5FD",30:"#60A5FA",40:"#3B82F6",50:"#1D4ED8",60:"#1E3A8A"};
      return map[parseInt(m[1])] ?? null;
    },
  },
  age_b: {
    label: "年代別パレットB",
    preview: ["#D1FAE5","#A7F3D0","#6EE7B7","#34D399","#10B981","#065F46"],
    colorFor(label) {
      const m = label.match(/(\d+)代/);
      if (!m) return null;
      const map = {10:"#D1FAE5",20:"#A7F3D0",30:"#6EE7B7",40:"#34D399",50:"#10B981",60:"#065F46"};
      return map[parseInt(m[1])] ?? null;
    },
  },
  scale_67: {
    label: "6〜7段階",
    preview: ["#9D174D","#EC4899","#F9A8D4","#D9D9D9","#93C5FD","#3B82F6","#1E3A8A"],
    colorFor(label) {
      if (/High3|TOP2/.test(label)) return "#9D174D";
      if (/High2|TOP3/.test(label)) return "#EC4899";
      if (/High1/.test(label))      return "#F9A8D4";
      if (/Middle/.test(label))     return "#D9D9D9";
      if (/Low1/.test(label))       return "#93C5FD";
      if (/Low2/.test(label))       return "#3B82F6";
      if (/Low3/.test(label))       return "#1E3A8A";
      return null;
    },
  },
  scale_1011: {
    label: "10〜11段階",
    preview: ["#9D174D","#DB2777","#EC4899","#F472B6","#F9A8D4","#D9D9D9","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
    colorFor(label) {
      if (/High5/.test(label))  return "#9D174D";
      if (/High4/.test(label))  return "#DB2777";
      if (/High3/.test(label))  return "#EC4899";
      if (/High2/.test(label))  return "#F472B6";
      if (/High1/.test(label))  return "#F9A8D4";
      if (/Middle/.test(label)) return "#D9D9D9";
      if (/Low1/.test(label))   return "#93C5FD";
      if (/Low2/.test(label))   return "#60A5FA";
      if (/Low3/.test(label))   return "#3B82F6";
      if (/Low4/.test(label))   return "#1D4ED8";
      if (/Low5/.test(label))   return "#1E3A8A";
      return null;
    },
  },
};
const FIXED_PALETTE_ORDER = ["fan_label","gender","age_gender","age_a","age_b","scale_67","scale_1011"];

function _detectFixedPaletteFromLabels(labels) {
  if (labels.some(l => /コアファン/.test(l)) && labels.some(l => /ライトファン/.test(l)))
    return "fan_label";
  if (labels.some(l => /\d+代(男性|女性)/.test(l)))
    return "age_gender";
  if (labels.some(l => /^男($|性)/.test(l)) || labels.some(l => /^女($|性)/.test(l)))
    return "gender";
  if (labels.some(l => /\d+代/.test(l)))
    return "age_a";
  if (labels.some(l => /High[1-5]|TOP[23]/.test(l)) && labels.some(l => /Low[1-5]/.test(l)))
    return labels.length > 7 ? "scale_1011" : "scale_67";
  return null;
}

function _getActiveFixedPaletteKey(labels) {
  const entry = AppState.step1AxisColors?.[AppState.step3ActiveAxisCode];
  if (entry && "fixedPalette" in entry) return entry.fixedPalette;
  return _detectFixedPaletteFromLabels(labels);
}

// Chart.js インスタンス管理
const _charts = new Map();
// 最後に取得したクロス集計データ（再描画用キャッシュ）
let _lastCrosstabData = null;
// カラーモーダル状態
let _colorModalIdx       = null;
let _colorModalLabels    = [];    // 現在の系列ラベル配列
let _colorModalPaletteKey = null; // モーダル内選択中パレットキー
let _colorModalOverrides  = {};   // { label: hex } 個別上書き
// ドラッグ状態（"color" | null）
let _dragType  = null;
let _dragValue = null;

// 色解決：個別上書き > 固定カラー > 選択パレット > STEP1軸パレット > COLORSデフォルト
function _getColorsForGraph(questionCode, labels) {
  const s = AppState.step3QuestionSettings[questionCode] ?? {};

  // 旧形式: selectedPalette キーがなく customColors が存在 → 旧パスにフォールバック
  if (!("selectedPalette" in s) && s.customColors?.length > 0) {
    return labels.map((_, i) => s.customColors[i % s.customColors.length]);
  }

  const overrides = s.overriddenSeriesColors ?? {};
  // 新形式: selectedPalette キーがあればそれを使用、なければ軸レベル or 自動検出
  const paletteKey = "selectedPalette" in s
    ? s.selectedPalette
    : _getActiveFixedPaletteKey(labels);
  const palette = paletteKey
    ? (FIXED_PALETTES[paletteKey] ?? _getUserPaletteObj(paletteKey))
    : null;

  return labels.map((l, i) => {
    if (overrides[l]) return overrides[l];
    const fc = _fixedColorFor(l);
    if (fc) return fc;
    if (palette) {
      if (palette.generatedColors) {
        return palette.generatedColors[i % palette.generatedColors.length];
      }
      const pc = palette.colorFor(l);
      if (pc) return pc;
    }
    return COLORS[i % COLORS.length];
  });
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

export function initStep3Panel() {
  // chartjs-plugin-datalabels の初期設定
  if (typeof ChartDataLabels !== "undefined") {
    Chart.register(ChartDataLabels);
    if (Chart.defaults.plugins) {
      Chart.defaults.plugins.datalabels = { display: false };
    }
  }

  document.addEventListener("survey:statechange", _onStateChange);
  document.getElementById("step3-run-btn")?.addEventListener("click", _runCrosstab);

  // イベント委譲: results コンテナに1度だけ登録
  const resultsEl = document.getElementById("step3-results");
  if (resultsEl) {
    resultsEl.addEventListener("change", _onResultsChange);
    resultsEl.addEventListener("click",  _onResultsClick);
  }

  // カラーモーダル初期化
  _initColorModal();
  _initGenPaletteSection();
}

// ---------------------------------------------------------------------------
// 状態変化ハンドラ
// ---------------------------------------------------------------------------

function _onStateChange() {
  if (AppState.activePanel !== "step3") return;
  _renderAxisCandidates();
  _renderAxisSelector();
  _updateRunButton();
}

// ---------------------------------------------------------------------------
// セクション1: 集計軸候補バッジ
// ---------------------------------------------------------------------------

function _renderAxisCandidates() {
  const el = document.getElementById("step3-axis-candidates");
  if (!el) return;
  const codes = AppState.step1AxisCodes;
  if (!codes.length) {
    el.innerHTML = '<span class="text-sm" style="color:var(--color-text-muted)">STEP1 で集計軸を選択してください。</span>';
    return;
  }
  el.innerHTML = codes
    .map(code => `<span class="badge">${_esc(_getAxisLabel(code))}</span>`)
    .join("");
}

// ---------------------------------------------------------------------------
// セクション2: ラジオボタン軸セレクター
// ---------------------------------------------------------------------------

function _renderAxisSelector() {
  const el = document.getElementById("step3-axis-selector");
  if (!el) return;
  const candidates = _getAxisCandidates();
  if (!candidates.length) {
    const hasStep2 = Boolean(AppState.step2Filename);
    const msg = hasStep2
      ? "STEP1 で選択した集計軸がデータと一致しませんでした。"
      : "STEP2 で回答データをアップロードしてください。";
    el.innerHTML = `<span class="text-sm" style="color:var(--color-text-muted)">${_esc(msg)}</span>`;
    return;
  }

  let currentCode = AppState.step3ActiveAxisCode;
  if (!candidates.includes(currentCode)) {
    currentCode = candidates[0];
    setStep3ActiveAxis(currentCode);
  }

  el.innerHTML = candidates
    .map(code => {
      const label = _getAxisLabel(code);
      const checked = code === currentCode ? "checked" : "";
      const bg = code === currentCode ? "var(--color-primary-light, #EFF6FF)" : "var(--color-surface-1, #fff)";
      return `
        <label class="step3-axis-radio-label" style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:6px 12px; border-radius:6px; border:1px solid var(--color-border); background:${bg}">
          <input type="radio" name="step3-axis" value="${_esc(code)}" ${checked} style="accent-color:var(--color-primary)">
          <span style="font-size:.9rem">${_esc(label)}</span>
        </label>`;
    })
    .join("");

  el.querySelectorAll("input[name='step3-axis']").forEach(radio => {
    radio.addEventListener("change", () => {
      if (radio.checked) setStep3ActiveAxis(radio.value);
    });
  });
}

// ---------------------------------------------------------------------------
// 実行ボタン制御
// ---------------------------------------------------------------------------

function _updateRunButton() {
  const btn  = document.getElementById("step3-run-btn");
  const note = document.getElementById("step3-run-note");
  if (!btn) return;
  const hasStep2 = Boolean(AppState.step2Filename);
  const hasAxis  = Boolean(AppState.step3ActiveAxisCode) && _getAxisCandidates().length > 0;
  btn.disabled = !hasStep2 || !hasAxis;
  if (note) {
    note.textContent = !hasStep2 ? "STEP2 で回答データをアップロードすると実行できます。"
                     : !hasAxis  ? "STEP1 で集計軸を選択してください。"
                     : "";
  }
}

// ---------------------------------------------------------------------------
// クロス集計実行
// ---------------------------------------------------------------------------

async function _runCrosstab() {
  const axisCode = AppState.step3ActiveAxisCode;
  if (!axisCode || !AppState.sessionToken) return;

  const btn       = document.getElementById("step3-run-btn");
  const resultsEl = document.getElementById("step3-results");
  if (!resultsEl) return;

  btn.disabled    = true;
  btn.textContent = "⏳ 集計中…";
  resultsEl.style.display = "none";
  _destroyAllCharts();

  try {
    const data = await generateCrosstab(AppState.sessionToken, axisCode);
    AppState.step3LastGeneratedAxisCode = axisCode;
    _lastCrosstabData = data;
    _renderResults(resultsEl, data);
    resultsEl.style.display = "";
  } catch (err) {
    resultsEl.style.display = "";
    resultsEl.innerHTML = `<div class="card"><div class="card-body" style="color:var(--color-danger,#e53e3e)">エラー: ${_esc(err.message)}</div></div>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = "📊 クロス集計を生成";
    _updateRunButton();
  }
}

// ---------------------------------------------------------------------------
// 結果描画
// ---------------------------------------------------------------------------

function _renderResults(container, data) {
  const { axis_question_text, axis_categories, axis_totals, results, warnings } = data;

  let html = "";

  // 軸サマリー
  html += `<div class="card" style="margin-bottom:8px">
    <div class="card-body" style="padding:12px 16px">
      <div style="font-weight:600; margin-bottom:8px">${_esc(axis_question_text)}（表側）</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px">`;
  const _axisCatColors = _getColorsForGraph("__axis__", axis_categories);
  axis_categories.forEach((cat, i) => {
    const color = _axisCatColors[i];
    html += `<span style="display:inline-flex; align-items:center; gap:4px; font-size:.85rem">
      <span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:${color}"></span>
      ${_esc(cat)} <span style="color:var(--color-text-muted)">n=${axis_totals[i] ?? 0}</span>
    </span>`;
  });
  html += `</div>`;
  if (warnings.length) {
    html += `<div style="margin-top:8px; color:var(--color-warning,#c05621); font-size:.8rem">${warnings.map(w => _esc(w)).join("<br>")}</div>`;
  }
  html += `</div></div>`;

  // 一括変更バー
  html += `<div class="card" style="margin-bottom:8px">
    <div class="card-body" style="padding:10px 16px; display:flex; align-items:center; flex-wrap:wrap; gap:8px">
      <span style="font-size:.85rem; font-weight:600; color:var(--color-text-muted)">一括変更：</span>
      <button data-bulk="sa-bar-v"       class="btn btn-secondary btn-sm step3-bulk-btn">SA → 縦棒</button>
      <button data-bulk="sa-stacked100-v" class="btn btn-secondary btn-sm step3-bulk-btn">SA → 100%積み上げ</button>
      <button data-bulk="ma-bar-h"        class="btn btn-secondary btn-sm step3-bulk-btn">MA → 横棒</button>
      <button data-bulk="nu-avg_bar-v"    class="btn btn-secondary btn-sm step3-bulk-btn">数値 → 平均棒</button>
      <span style="width:1px; height:18px; background:var(--color-border,#E2E8F0); margin:0 4px"></span>
      <button data-bulk-transpose="true"  class="btn btn-secondary btn-sm step3-bulk-transpose-btn">全て行列入替</button>
      <button data-bulk-transpose="false" class="btn btn-secondary btn-sm step3-bulk-transpose-btn">全て通常に戻す</button>
    </div>
  </div>`;

  // 一括エクスポートバー
  html += `<div class="card" style="margin-bottom:8px">
    <div class="card-body" style="padding:10px 16px; display:flex; align-items:center; flex-wrap:wrap; gap:8px">
      <span style="font-size:.85rem; font-weight:600; color:var(--color-text-muted)">一括出力：</span>
      <button id="step3-export-all-excel" class="btn btn-secondary btn-sm">📥 すべてExcel</button>
      <button id="step3-export-all-csv"   class="btn btn-secondary btn-sm">📥 すべてCSV (ZIP)</button>
      <button id="step3-export-all-png"   class="btn btn-secondary btn-sm">📥 すべてPNG</button>
    </div>
  </div>`;

  // 設問ごとのカード
  results.forEach((result, idx) => {
    const settings = _getSettings(result.question_code, result.type_code);
    const recommended = _recommendedType(result.type_code);
    const recommendedLabel = _recommendedLabel(result.type_code);

    const chartBtnGroup = `<div class="step3-chart-type-btns">${
      CHART_TYPES.map(t => {
        const suit = _chartSuitability(t.id, result.type_code);
        const active = t.id === settings.chartType ? " active" : "";
        const cls = suit === "not_recommended" ? " not-recommended" : "";
        const title = suit === "not_recommended" ? `${t.label}（非推奨）` : t.label;
        return `<button class="step3-chart-btn${active}${cls}" data-q="${_esc(result.question_code)}" data-idx="${idx}" data-chart="${t.id}" title="${_esc(title)}">${_esc(t.label)}</button>`;
      }).join("")
    }</div>`;

    // 向きラジオ・行列入替（bar/stacked100/grouped のみ）
    const showOrient = ORIENTATION_TYPES.has(settings.chartType);
    const orientHtml = showOrient ? `
      <span class="step3-orient-ctrl">
        向き：
        <label style="font-size:.82rem; cursor:pointer">
          <input type="radio" class="step3-orient-radio"
                 name="step3-orient-${idx}" value="v"
                 data-q="${_esc(result.question_code)}" data-idx="${idx}"
                 ${settings.orientation === "v" ? "checked" : ""}> 縦
        </label>
        <label style="font-size:.82rem; cursor:pointer">
          <input type="radio" class="step3-orient-radio"
                 name="step3-orient-${idx}" value="h"
                 data-q="${_esc(result.question_code)}" data-idx="${idx}"
                 ${settings.orientation === "h" ? "checked" : ""}> 横
        </label>
      </span>` : "";
    const transposeHtml = showOrient ? `
      <span class="step3-transpose-ctrl">
        表示方向：
        <label style="font-size:.82rem; cursor:pointer">
          <input type="radio" class="step3-transpose-radio"
                 name="step3-transpose-${idx}" value="false"
                 data-q="${_esc(result.question_code)}" data-idx="${idx}"
                 ${!settings.transpose ? "checked" : ""}> 通常
        </label>
        <label style="font-size:.82rem; cursor:pointer">
          <input type="radio" class="step3-transpose-radio"
                 name="step3-transpose-${idx}" value="true"
                 data-q="${_esc(result.question_code)}" data-idx="${idx}"
                 ${settings.transpose ? "checked" : ""}> 行列入替
        </label>
      </span>` : "";

    // 除外バッジ（除外中のみ表示）
    const excludedBadge = `<span id="step3-excluded-badge-${idx}" class="badge-excluded"${settings.excluded ? "" : " hidden"}>除外</span>`;

    html += `
    <div id="step3-card-${idx}" class="card${settings.excluded ? " step3-excluded-card" : ""}" style="margin-bottom:8px">

      <!-- タイトル行: 常時表示 -->
      <div class="card-header" style="padding:10px 16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px">
        <div>
          <span class="text-sm" style="color:var(--color-text-muted); margin-right:4px">${_esc(result.question_code)}</span>
          <span style="font-weight:600; font-size:.95rem">${_esc(result.question_text)}</span>
          ${excludedBadge}
        </div>
        <div style="display:flex; gap:6px; flex-shrink:0; flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm step3-choices-toggle-btn"
                  data-q="${_esc(result.question_code)}" data-idx="${idx}">
            🔧 表示選択肢
          </button>
          <button class="btn btn-secondary btn-sm step3-color-btn"
                  data-q="${_esc(result.question_code)}" data-idx="${idx}">
            🎨 カラー設定
          </button>
          <button class="btn btn-secondary btn-sm step3-exclude-btn"
                  data-q="${_esc(result.question_code)}" data-idx="${idx}"
                  data-excluded="${settings.excluded}">
            ${settings.excluded ? "出力対象に戻す" : "除外する"}
          </button>
          <button class="btn btn-secondary btn-sm step3-collapse-btn"
                  data-q="${_esc(result.question_code)}" data-idx="${idx}">
            ${settings.collapsed ? "展開 ▼" : "折りたたむ ▲"}
          </button>
          <button class="btn btn-secondary btn-sm step3-export-excel-btn" data-idx="${idx}" title="Excelとして保存">📊 Excel</button>
          <button class="btn btn-secondary btn-sm step3-export-csv-btn"   data-idx="${idx}" title="CSVとして保存">📄 CSV</button>
          <button class="btn btn-secondary btn-sm step3-export-png-btn"   data-idx="${idx}" title="PNGとして保存">🖼 PNG</button>
        </div>
      </div>

      <!-- 折りたたみ可能ボディ -->
      <div id="step3-body-${idx}"${settings.collapsed ? " hidden" : ""}>

        <!-- グラフ設定バー -->
        <div class="step3-controls-bar">
          <span style="font-size:.78rem; color:var(--color-text-muted)">推奨: ${_esc(recommendedLabel)}</span>
          ${chartBtnGroup}
          <button class="btn btn-secondary btn-sm step3-chart-reset-btn"
                  data-q="${_esc(result.question_code)}" data-type="${_esc(recommended)}" data-idx="${idx}">
            推奨に戻す
          </button>
          ${orientHtml}
          <label class="step3-pct-label-wrap">
            <input type="checkbox" class="step3-pct-label-cb"
                   data-q="${_esc(result.question_code)}" data-idx="${idx}"
                   ${settings.showPctLabel ? "checked" : ""}> ％ラベル
          </label>
          <span style="font-size:.82rem; color:var(--color-text-muted)">ソート：</span>
          <select class="step3-sort-select" data-q="${_esc(result.question_code)}" data-idx="${idx}">
            <option value="original"${settings.sortOrder === "original" ? " selected" : ""}>元の順番</option>
            <option value="desc"    ${settings.sortOrder === "desc"     ? " selected" : ""}>降順</option>
            <option value="asc"     ${settings.sortOrder === "asc"      ? " selected" : ""}>昇順</option>
          </select>
          ${transposeHtml}
        </div>

        <!-- 表示選択肢パネル -->
        ${_buildChoicesPanel(result, idx, settings.hiddenChoices)}

        <!-- グラフ + 表 -->
        <div class="card-body" style="padding:16px">
          <div id="step3-chart-area-${idx}" class="step3-chart-area" style="margin-bottom:12px"></div>
          ${_buildTabbedTable(result, axis_categories, axis_totals, idx, settings)}
        </div>
      </div>

    </div>`;
  });

  if (!results.length) {
    html += `<div class="card"><div class="card-body" style="color:var(--color-text-muted); text-align:center; padding:32px">
      クロス集計できる設問がありませんでした。
    </div></div>`;
  }

  container.innerHTML = html;

  // 各設問のグラフを描画（折りたたまれていないもののみ）
  results.forEach((result, idx) => {
    const settings = _getSettings(result.question_code, result.type_code);
    if (settings.collapsed) return;
    const areaEl = document.getElementById(`step3-chart-area-${idx}`);
    if (!areaEl) return;
    _renderChartInArea(areaEl, result, settings, axis_categories, axis_totals);
  });

  // 一括エクスポートボタンにイベントを登録
  initStep3ExportBulkButtons();
}

// ---------------------------------------------------------------------------
// イベント委譲ハンドラ
// ---------------------------------------------------------------------------

function _onResultsChange(e) {
  // 軸ラジオ（STEP3 軸セレクターと被らないよう step3-orient-radio でフィルタ）
  const orientRadio = e.target.closest(".step3-orient-radio");
  if (orientRadio?.checked) {
    setStep3Setting(orientRadio.dataset.q, "orientation", orientRadio.value);
    _rerenderQuestion(parseInt(orientRadio.dataset.idx, 10));
    return;
  }

  // 行列入替ラジオ
  const transposeRadio = e.target.closest(".step3-transpose-radio");
  if (transposeRadio?.checked) {
    setStep3Setting(transposeRadio.dataset.q, "transpose", transposeRadio.value === "true");
    _rerenderQuestionFull(parseInt(transposeRadio.dataset.idx, 10));
    return;
  }

  // 表示選択肢 チェックボックス
  const choiceCb = e.target.closest(".step3-choice-cb");
  if (choiceCb) {
    const idx    = parseInt(choiceCb.dataset.idx, 10);
    const result = _lastCrosstabData?.results[idx];
    if (!result) return;
    const current = _getSettings(result.question_code, result.type_code).hiddenChoices ?? [];
    const label = choiceCb.dataset.label;
    const newHidden = choiceCb.checked
      ? current.filter(l => l !== label)
      : [...new Set([...current, label])];
    setStep3Setting(choiceCb.dataset.q, "hiddenChoices", newHidden);
    _rerenderQuestionFull(idx);
    return;
  }

  // ソートセレクト
  const sortSel = e.target.closest(".step3-sort-select");
  if (sortSel) {
    setStep3Setting(sortSel.dataset.q, "sortOrder", sortSel.value);
    _rerenderQuestionFull(parseInt(sortSel.dataset.idx, 10));
    return;
  }
}

function _onResultsClick(e) {
  // グラフタイプ ボタングループ
  const chartBtn = e.target.closest(".step3-chart-btn");
  if (chartBtn) {
    const qCode = chartBtn.dataset.q;
    const idx   = parseInt(chartBtn.dataset.idx, 10);
    const chart = chartBtn.dataset.chart;
    setStep3Setting(qCode, "chartType", chart);
    chartBtn.closest(".step3-chart-type-btns")
      .querySelectorAll(".step3-chart-btn")
      .forEach(b => b.classList.toggle("active", b.dataset.chart === chart));
    _toggleOrientCtrl(idx, chart);
    _rerenderQuestionFull(idx);
    return;
  }

  // 表示選択肢パネル toggle
  const choicesToggle = e.target.closest(".step3-choices-toggle-btn");
  if (choicesToggle) {
    const panel = document.getElementById(`step3-choices-panel-${choicesToggle.dataset.idx}`);
    if (panel) panel.hidden = !panel.hidden;
    return;
  }

  // すべて表示 / 初期状態に戻す
  const showAllBtn = e.target.closest(".step3-choices-show-all-btn, .step3-choices-reset-btn");
  if (showAllBtn) {
    const qCode = showAllBtn.dataset.q;
    const idx   = parseInt(showAllBtn.dataset.idx, 10);
    setStep3Setting(qCode, "hiddenChoices", []);
    document.querySelectorAll(`#step3-choices-panel-${idx} .step3-choice-cb`)
      .forEach(cb => { cb.checked = true; });
    _rerenderQuestionFull(idx);
    return;
  }

  // タブ切り替え
  const tabBtn = e.target.closest(".step3-tab-btn");
  if (tabBtn) {
    const tabArea = tabBtn.closest(".step3-tab-area");
    if (!tabArea) return;
    tabArea.querySelectorAll(".step3-tab-btn").forEach(b => b.classList.remove("active"));
    tabArea.querySelectorAll(".step3-tab-panel").forEach(p => { p.hidden = true; });
    tabBtn.classList.add("active");
    const target = document.getElementById(tabBtn.dataset.tabTarget);
    if (target) target.hidden = false;
    return;
  }

  // 推奨に戻す
  const resetBtn = e.target.closest(".step3-chart-reset-btn");
  if (resetBtn) {
    const qCode       = resetBtn.dataset.q;
    const recommended = resetBtn.dataset.type;
    const idx         = parseInt(resetBtn.dataset.idx, 10);
    setStep3Setting(qCode, "chartType", recommended);
    document.querySelectorAll(`.step3-chart-btn[data-q="${qCode}"]`)
      .forEach(b => b.classList.toggle("active", b.dataset.chart === recommended));
    _toggleOrientCtrl(idx, recommended);
    _rerenderQuestionFull(idx);
    return;
  }

  // ％ラベル checkbox (click で change より確実に検知)
  const pctCb = e.target.closest(".step3-pct-label-cb");
  if (pctCb) {
    setStep3Setting(pctCb.dataset.q, "showPctLabel", pctCb.checked);
    _rerenderQuestion(parseInt(pctCb.dataset.idx, 10));
    return;
  }

  // カラー設定
  const colorBtn = e.target.closest(".step3-color-btn");
  if (colorBtn) {
    _openColorModal(parseInt(colorBtn.dataset.idx, 10));
    return;
  }

  // 折りたたみ
  const collapseBtn = e.target.closest(".step3-collapse-btn");
  if (collapseBtn) {
    const idx    = parseInt(collapseBtn.dataset.idx, 10);
    const bodyEl = document.getElementById(`step3-body-${idx}`);
    const newCollapsed = !bodyEl.hidden;
    bodyEl.hidden = newCollapsed;
    collapseBtn.textContent = newCollapsed ? "展開 ▼" : "折りたたむ ▲";
    setStep3Setting(collapseBtn.dataset.q, "collapsed", newCollapsed);
    // 展開時にグラフを描画（まだ描画されていない場合）
    if (!newCollapsed) {
      const result = _lastCrosstabData?.results[idx];
      const areaEl = document.getElementById(`step3-chart-area-${idx}`);
      if (result && areaEl && !_charts.has(areaEl.id)) {
        const settings = _getSettings(result.question_code, result.type_code);
        _renderChartInArea(areaEl, result, settings,
          _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals);
      }
    }
    return;
  }

  // 除外切替
  const excludeBtn = e.target.closest(".step3-exclude-btn");
  if (excludeBtn) {
    const idx        = parseInt(excludeBtn.dataset.idx, 10);
    const nowExcluded = excludeBtn.dataset.excluded === "true";
    const next       = !nowExcluded;
    excludeBtn.dataset.excluded = next;
    excludeBtn.textContent      = next ? "出力対象に戻す" : "除外する";
    setStep3Setting(excludeBtn.dataset.q, "excluded", next);
    const badge = document.getElementById(`step3-excluded-badge-${idx}`);
    if (badge) badge.hidden = !next;
    const card = document.getElementById(`step3-card-${idx}`);
    if (card) card.classList.toggle("step3-excluded-card", next);
    return;
  }

  // 個別エクスポート（Excel / CSV / PNG）
  const excelBtn = e.target.closest(".step3-export-excel-btn");
  if (excelBtn) { exportSingleExcel(parseInt(excelBtn.dataset.idx, 10)); return; }
  const csvBtn = e.target.closest(".step3-export-csv-btn");
  if (csvBtn)   { exportSingleCsv(parseInt(csvBtn.dataset.idx, 10));   return; }
  const pngBtn = e.target.closest(".step3-export-png-btn");
  if (pngBtn)   { exportSinglePng(parseInt(pngBtn.dataset.idx, 10));   return; }

  // 一括変更（グラフ種別・向き）
  const bulkBtn = e.target.closest(".step3-bulk-btn");
  if (bulkBtn) {
    _handleBulkChange(bulkBtn.dataset.bulk);
    return;
  }

  // 一括行列入替
  const bulkTransposeBtn = e.target.closest(".step3-bulk-transpose-btn");
  if (bulkTransposeBtn) {
    _handleBulkTranspose(bulkTransposeBtn.dataset.bulkTranspose === "true");
  }
}

// ---------------------------------------------------------------------------
// グラフのみ再描画
// ---------------------------------------------------------------------------

function _rerenderQuestion(idx) {
  if (!_lastCrosstabData) return;
  const result = _lastCrosstabData.results[idx];
  if (!result) return;
  const areaEl = document.getElementById(`step3-chart-area-${idx}`);
  if (!areaEl) return;
  const settings = _getSettings(result.question_code, result.type_code);
  _renderChartInArea(areaEl, result, settings,
    _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals);
}

// グラフ + 表の両方を再描画（ソート変更時）
function _rerenderQuestionFull(idx) {
  if (!_lastCrosstabData) return;
  const result = _lastCrosstabData.results[idx];
  if (!result) return;
  const settings = _getSettings(result.question_code, result.type_code);

  const areaEl = document.getElementById(`step3-chart-area-${idx}`);
  if (areaEl) {
    _renderChartInArea(areaEl, result, settings,
      _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals);
  }

  const hidden = settings.hiddenChoices ?? [];
  const sortedResult = {
    ...result,
    rows: _sortedRows(result.rows.filter(r => !hidden.includes(r.label)), settings.sortOrder),
  };
  const tp = settings.transpose ?? false;
  const pctPanel = document.getElementById(`step3-tab-pct-${idx}`);
  const nPanel   = document.getElementById(`step3-tab-n-${idx}`);
  if (pctPanel) pctPanel.innerHTML = _buildPctTable(sortedResult,
    _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals, tp);
  if (nPanel) nPanel.innerHTML = _buildNTable(sortedResult,
    _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals, tp);
}

// ---------------------------------------------------------------------------
// 向きコントロールの表示切替（グラフ種別変更時）
// ---------------------------------------------------------------------------

function _toggleOrientCtrl(idx, chartType) {
  const bar = document.querySelector(`#step3-body-${idx} .step3-controls-bar`);
  if (!bar) return;
  const show = ORIENTATION_TYPES.has(chartType) ? "" : "none";
  const orientSpan    = bar.querySelector(".step3-orient-ctrl");
  const transposeSpan = bar.querySelector(".step3-transpose-ctrl");
  if (orientSpan)    orientSpan.style.display    = show;
  if (transposeSpan) transposeSpan.style.display = show;
}

// ---------------------------------------------------------------------------
// グラフエリアへのレンダリング
// ---------------------------------------------------------------------------

function _renderChartInArea(areaEl, result, settings, axisCategories, axisTotals) {
  const { chartType, orientation, showPctLabel, sortOrder, transpose } = settings;

  // 既存チャートを破棄
  const areaKey = areaEl.id;
  const existing = _charts.get(areaKey);
  if (existing) {
    (Array.isArray(existing) ? existing : [existing]).forEach(c => c.destroy());
    _charts.delete(areaKey);
  }
  areaEl.innerHTML = "";

  if (chartType === "table_only") {
    areaEl.style.display = "none";
    areaEl.style.height  = "0";
    return;
  }
  areaEl.style.display = "";
  areaEl.style.height  = "";

  const hidden = settings.hiddenChoices ?? [];
  const rows   = _sortedRows(result.rows.filter(r => !hidden.includes(r.label)), sortOrder);
  const sorted = { ...result, rows };
  const isH    = orientation === "h";
  const tp     = transpose ?? false;

  if (chartType === "pie") {
    areaEl.style.display   = "flex";
    areaEl.style.flexWrap  = "wrap";
    areaEl.style.gap       = "12px";
    areaEl.style.height    = "auto";
    _renderPieCharts(areaEl, sorted, axisCategories, areaKey);
    return;
  }

  if (chartType === "radar") {
    areaEl.style.position = "relative";
    areaEl.style.height   = "300px";
    const canvas = document.createElement("canvas");
    areaEl.appendChild(canvas);
    _charts.set(areaKey, new Chart(canvas, _buildRadarConfig(sorted, axisCategories)));
    return;
  }

  if (chartType === "scatter") {
    areaEl.style.position = "relative";
    areaEl.style.height   = "280px";
    const canvas = document.createElement("canvas");
    areaEl.appendChild(canvas);
    _charts.set(areaKey, new Chart(canvas, _buildScatterConfig(sorted, axisCategories)));
    return;
  }

  areaEl.style.position = "relative";
  areaEl.style.height   = "260px";
  const canvas = document.createElement("canvas");
  areaEl.appendChild(canvas);

  let config;
  if (chartType === "avg_bar")         config = _buildAvgBarConfig(sorted, axisCategories, showPctLabel);
  else if (chartType === "stacked100") config = _buildStacked100Config(sorted, axisCategories, isH, showPctLabel, tp);
  else if (chartType === "grouped")    config = _buildGroupedConfig(sorted, axisCategories, isH, showPctLabel, tp);
  else if (chartType === "line")       config = _buildLineConfig(sorted, axisCategories, showPctLabel, tp);
  else                                 config = _buildBarConfig(sorted, axisCategories, isH, showPctLabel, tp);

  _charts.set(areaKey, new Chart(canvas, config));
}

// ---------------------------------------------------------------------------
// Chart.js config ビルダー
// ---------------------------------------------------------------------------

function _datalabels(show, isH, stacked = false) {
  if (!show) return { display: false };
  if (stacked) {
    return {
      display:    ctx => ctx.parsed && (isH ? ctx.parsed.x : ctx.parsed.y) >= 5,
      anchor:     "center",
      align:      "center",
      formatter:  v => `${v.toFixed(1)}%`,
      font:       { size: 9 },
      color:      "#fff",
    };
  }
  return {
    display:    ctx => ctx.parsed && (isH ? ctx.parsed.x : ctx.parsed.y) >= 3,
    anchor:     "end",
    align:      isH ? "right" : "top",
    formatter:  v => `${v.toFixed(1)}%`,
    font:       { size: 9 },
    color:      "#555",
    clamp:      true,
  };
}

function _barScales(isH) {
  return isH
    ? { x: { beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } },
        y: { ticks: { font: { size: 10 } } } }
    : { x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } } };
}

/** 棒グラフ（bar + orientation）
 *  transpose=true → labels=集計軸, datasets=選択肢（grouped 相当） */
function _buildBarConfig(result, axisCategories, isH, showPctLabel, transpose = false) {
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label: row.label,
      data:  axisCategories.map((_, ci) => row.percents[ci] ?? 0),
      backgroundColor: palette[ri],
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label: cat,
      data:  result.rows.map(r => r.percents[ci] ?? 0),
      backgroundColor: palette[ci],
    }));
  }
  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis:            isH ? "y" : "x",
      responsive:           true,
      maintainAspectRatio:  false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => { const v = ctx.parsed ? (isH ? ctx.parsed.x : ctx.parsed.y) : null; return `${ctx.dataset.label}: ${v !== null ? v.toFixed(1) : "N/A"}%`; } } },
        datalabels: _datalabels(showPctLabel, isH),
      },
      scales: _barScales(isH),
    },
  };
}

/** 100%積み上げ棒
 *  transpose=false → labels=選択肢, datasets=集計軸（各軸カテゴリーで正規化）
 *  transpose=true  → labels=集計軸, datasets=選択肢（各軸カテゴリーで正規化） */
function _buildStacked100Config(result, axisCategories, isH, showPctLabel, transpose = false) {
  // 軸カテゴリーごとの percents 合計（正規化の分母）
  const sums = axisCategories.map((_, ci) =>
    result.rows.reduce((s, r) => s + (r.percents[ci] ?? 0), 0)
  );
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label: row.label,
      data: axisCategories.map((_, ci) => {
        const raw = row.percents[ci] ?? 0;
        return sums[ci] > 0 ? Math.round(raw / sums[ci] * 1000) / 10 : 0;
      }),
      backgroundColor: palette[ri],
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label: cat,
      data: result.rows.map(r => {
        const raw = r.percents[ci] ?? 0;
        return sums[ci] > 0 ? Math.round(raw / sums[ci] * 1000) / 10 : 0;
      }),
      backgroundColor: palette[ci],
    }));
  }
  const stackedScales = isH
    ? { x: { stacked: true, beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } },
        y: { stacked: true, ticks: { font: { size: 10 } } } }
    : { x: { stacked: true, ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { stacked: true, beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } } };
  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis:            isH ? "y" : "x",
      responsive:           true,
      maintainAspectRatio:  false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => { const v = ctx.parsed ? (isH ? ctx.parsed.x : ctx.parsed.y) : null; return `${ctx.dataset.label}: ${v !== null ? v.toFixed(1) : "N/A"}%`; } } },
        datalabels: _datalabels(showPctLabel, isH, true),
      },
      scales: stackedScales,
    },
  };
}

/** grouped棒（軸カテゴリをX軸、選択肢をデータセット）
 *  transpose=true → labels=選択肢, datasets=集計軸（bar 通常と同じ構造） */
function _buildGroupedConfig(result, axisCategories, isH, showPctLabel, transpose = false) {
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label: cat,
      data:  result.rows.map(r => r.percents[ci] ?? 0),
      backgroundColor: palette[ci],
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label: row.label,
      data:  axisCategories.map((_, ci) => row.percents[ci] ?? 0),
      backgroundColor: palette[ri],
    }));
  }
  const scales = isH
    ? { x: { beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } },
        y: { ticks: { font: { size: 10 } } } }
    : { x: { ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } } };
  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis:            isH ? "y" : "x",
      responsive:           true,
      maintainAspectRatio:  false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => { const v = ctx.parsed ? (isH ? ctx.parsed.x : ctx.parsed.y) : null; return `${ctx.dataset.label}: ${v !== null ? v.toFixed(1) : "N/A"}%`; } } },
        datalabels: _datalabels(showPctLabel, isH),
      },
      scales,
    },
  };
}

/** 平均棒（数値ラベルから加重平均を計算） */
function _buildAvgBarConfig(result, axisCategories, showPctLabel) {
  const avgs = axisCategories.map((_, ci) => {
    let sumV = 0, sumN = 0;
    for (const row of result.rows) {
      const v = parseFloat(row.label);
      if (!isNaN(v)) { sumV += v * (row.counts[ci] ?? 0); sumN += row.counts[ci] ?? 0; }
    }
    return sumN > 0 ? Math.round((sumV / sumN) * 10) / 10 : null;
  });

  return {
    type: "bar",
    data: {
      labels:   axisCategories,
      datasets: [{
        label: "平均値",
        data:  avgs,
        backgroundColor: _getColorsForGraph(result.question_code, axisCategories),
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend:     { display: false },
        tooltip:    { callbacks: { label: ctx => `平均: ${ctx.parsed && ctx.parsed.y !== null ? ctx.parsed.y.toFixed(2) : "N/A"}` } },
        datalabels: showPctLabel ? {
          display:    ctx => ctx.parsed != null && ctx.parsed.y !== null,
          anchor:     "end",
          align:      "top",
          formatter:  v => v !== null ? v.toFixed(2) : "",
          font:       { size: 10 },
          color:      "#555",
          clamp:      true,
        } : { display: false },
      },
      scales: {
        x: { ticks: { font: { size: 11 } } },
        y: { beginAtZero: true },
      },
    },
  };
}

/** 円グラフ（軸カテゴリごとに小さな pie） */
function _renderPieCharts(areaEl, result, axisCategories, areaKey) {
  const pieColors = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
  const pies = [];

  axisCategories.forEach((cat, ci) => {
    const wrapper     = document.createElement("div");
    wrapper.style.cssText = "min-width:140px; flex:1; text-align:center; max-width:220px";
    const catLabel    = document.createElement("div");
    catLabel.style.cssText = "font-size:.78rem; margin-bottom:4px; color:var(--color-text-muted)";
    catLabel.textContent   = cat;
    const canvasWrap  = document.createElement("div");
    canvasWrap.style.cssText = "position:relative; height:160px";
    const canvas = document.createElement("canvas");
    canvasWrap.appendChild(canvas);
    wrapper.appendChild(catLabel);
    wrapper.appendChild(canvasWrap);
    areaEl.appendChild(wrapper);

    pies.push(new Chart(canvas, {
      type: "pie",
      data: {
        labels:   result.rows.map(r => r.label),
        datasets: [{ data: result.rows.map(r => r.percents[ci] ?? 0), backgroundColor: pieColors }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend:     { display: false },
          tooltip:    { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toFixed(1)}%` } },
          datalabels: { display: false },
        },
      },
    }));
  });

  _charts.set(areaKey, pies);
}

/** 折れ線グラフ（縦固定, orientation 不使用）
 *  transpose=false → X=選択肢, lines=軸カテゴリ
 *  transpose=true  → X=軸カテゴリ, lines=選択肢 */
function _buildLineConfig(result, axisCategories, showPctLabel, transpose = false) {
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label:           row.label,
      data:            axisCategories.map((_, ci) => row.percents[ci] ?? 0),
      borderColor:     palette[ri],
      backgroundColor: palette[ri] + "40",
      fill:            false,
      tension:         0.3,
      pointRadius:     4,
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label:           cat,
      data:            result.rows.map(r => r.percents[ci] ?? 0),
      borderColor:     palette[ci],
      backgroundColor: palette[ci] + "40",
      fill:            false,
      tension:         0.3,
      pointRadius:     4,
    }));
  }
  return {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? "N/A"}%` } },
        datalabels: showPctLabel
          ? { display: true, formatter: v => `${v.toFixed(1)}%`, font: { size: 9 }, color: "#555", anchor: "end", align: "top", clamp: true }
          : { display: false },
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { beginAtZero: true, ticks: { callback: v => `${v}%` } },
      },
    },
  };
}

/** レーダーチャート
 *  spokes = 選択肢, datasets = 軸カテゴリ */
function _buildRadarConfig(result, axisCategories) {
  const palette = _getColorsForGraph(result.question_code, axisCategories);
  const labels  = result.rows.map(r => r.label);
  const datasets = axisCategories.map((cat, ci) => ({
    label:           cat,
    data:            result.rows.map(r => r.percents[ci] ?? 0),
    borderColor:     palette[ci],
    backgroundColor: palette[ci] + "30",
    fill:            true,
    pointRadius:     3,
  }));
  return {
    type: "radar",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        datalabels: { display: false },
      },
      scales: {
        r: {
          beginAtZero: true,
          ticks: { callback: v => `${v}%`, font: { size: 9 } },
          pointLabels: { font: { size: 10 } },
        },
      },
    },
  };
}

/** 散布図: X=選択肢インデックス, Y=%, datasets=軸カテゴリ */
function _buildScatterConfig(result, axisCategories) {
  const palette  = _getColorsForGraph(result.question_code, axisCategories);
  const datasets = axisCategories.map((cat, ci) => ({
    label:           cat,
    data:            result.rows.map((row, ri) => ({ x: ri, y: row.percents[ci] ?? 0 })),
    backgroundColor: palette[ci],
    pointRadius:     6,
  }));
  return {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    {
          callbacks: {
            label: ctx => {
              const choiceLabel = result.rows[ctx.parsed.x]?.label ?? String(ctx.parsed.x);
              return `${ctx.dataset.label} / ${choiceLabel}: ${ctx.parsed.y.toFixed(1)}%`;
            },
          },
        },
        datalabels: { display: false },
      },
      scales: {
        x: {
          type:  "linear",
          min:   -0.5,
          max:   result.rows.length - 0.5,
          ticks: { callback: v => result.rows[v]?.label ?? "", font: { size: 10 }, maxRotation: 45, stepSize: 1 },
        },
        y: { beginAtZero: true, ticks: { callback: v => `${v}%` } },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 一括変更
// ---------------------------------------------------------------------------

function _handleBulkChange(bulkKey) {
  const data = _lastCrosstabData;
  if (!data) return;

  // bulkKey 形式: "{typePrefix}-{chartType}-{orientation}"
  // 例: "sa-stacked100-v", "ma-bar-h"
  const parts       = bulkKey.split("-");
  const typePrefix  = parts[0];
  const chartType   = parts[1];
  const orientation = parts[2] ?? "v";

  const targetTypeCodes = {
    sa: ["SA", "S"],
    ma: ["MA", "ML", "M"],
    nu: ["NU", "N"],
  }[typePrefix] ?? [];

  const updates = {};
  data.results.forEach((result, idx) => {
    if (!targetTypeCodes.includes(result.type_code)) return;
    updates[result.question_code] = { chartType, orientation };
    document.querySelectorAll(`.step3-chart-btn[data-q="${result.question_code}"]`)
      .forEach(b => b.classList.toggle("active", b.dataset.chart === chartType));
    _toggleOrientCtrl(idx, chartType);
    _rerenderQuestion(idx);
  });

  if (Object.keys(updates).length > 0) setStep3SettingsBulk(updates);
}

function _handleBulkTranspose(value) {
  const data = _lastCrosstabData;
  if (!data) return;

  const updates = {};
  data.results.forEach((result, idx) => {
    const settings = _getSettings(result.question_code, result.type_code);
    // 向き選択が有効なチャート種別のみ対象（pie / avg_bar / table_only は非対象）
    if (!ORIENTATION_TYPES.has(settings.chartType)) return;
    updates[result.question_code] = { transpose: value };
    // ラジオボタンの DOM を更新
    const radios = document.querySelectorAll(`.step3-transpose-radio[data-q="${result.question_code}"]`);
    radios.forEach(r => { r.checked = (r.value === "true") === value; });
    _rerenderQuestionFull(idx);
  });

  if (Object.keys(updates).length > 0) setStep3SettingsBulk(updates);
}

// ---------------------------------------------------------------------------
// 表示選択肢パネル
// ---------------------------------------------------------------------------

function _buildChoicesPanel(result, idx, hiddenChoices) {
  const qCode = result.question_code;
  const checkboxes = result.rows.map(row => {
    const checked = !(hiddenChoices ?? []).includes(row.label) ? "checked" : "";
    return `<label class="step3-choice-row">
      <input type="checkbox" class="step3-choice-cb"
             data-q="${_esc(qCode)}" data-idx="${idx}"
             data-label="${_esc(row.label)}" ${checked}>
      ${_esc(row.label)}
    </label>`;
  }).join("");
  return `<div id="step3-choices-panel-${idx}" class="step3-choices-panel" hidden>
    <div class="step3-choices-actions">
      <button class="btn btn-secondary btn-sm step3-choices-show-all-btn"
              data-q="${_esc(qCode)}" data-idx="${idx}">すべて表示</button>
      <button class="btn btn-secondary btn-sm step3-choices-reset-btn"
              data-q="${_esc(qCode)}" data-idx="${idx}">初期状態に戻す</button>
    </div>
    <div class="step3-choices-list">${checkboxes}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// クロス表（タブ式: ％表 / N表）
// ---------------------------------------------------------------------------

function _buildTabbedTable(result, axisCategories, axisTotals, idx, settings) {
  const pctId  = `step3-tab-pct-${idx}`;
  const nId    = `step3-tab-n-${idx}`;
  const hidden = settings.hiddenChoices ?? [];
  const sorted = {
    ...result,
    rows: _sortedRows(result.rows.filter(r => !hidden.includes(r.label)), settings.sortOrder),
  };
  const tp = settings.transpose ?? false;

  return `<div class="step3-tab-area">
    <div class="step3-tab-bar">
      <button class="step3-tab-btn active" data-tab-target="${pctId}">％表</button>
      <button class="step3-tab-btn"        data-tab-target="${nId}">N表</button>
    </div>
    <div id="${pctId}" class="step3-tab-panel">
      ${_buildPctTable(sorted, axisCategories, axisTotals, tp)}
    </div>
    <div id="${nId}" class="step3-tab-panel" hidden>
      ${_buildNTable(sorted, axisCategories, axisTotals, tp)}
    </div>
  </div>`;
}

function _buildPctTable(result, axisCategories, axisTotals, transpose = false) {
  if (transpose) {
    // 行=集計軸カテゴリー, 列=選択肢
    const headerCols = result.rows
      .map(row => `<th style="text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem" title="${_esc(row.label)}">${_esc(row.label)}</th>`)
      .join("");
    const rows = axisCategories
      .map((cat, ci) => {
        const cells = result.rows
          .map(row => `<td style="text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap">${row.percents[ci]?.toFixed(1) ?? "0.0"}%</td>`)
          .join("");
        return `<tr><td style="padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis" title="${_esc(cat)}">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted); font-size:.75rem">n=${axisTotals[ci] ?? 0}</span></td>${cells}</tr>`;
      })
      .join("");
    return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
      <thead style="background:var(--color-surface-2,#F8F8F8)">
        <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">集計軸</th>${headerCols}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  // 通常: 行=選択肢, 列=集計軸カテゴリー
  const headerCols = axisCategories
    .map((cat, i) => `<th style="text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted)">n=${axisTotals[i] ?? 0}</span></th>`)
    .join("");
  const rows = result.rows
    .map(row => {
      const cells = axisCategories
        .map((_, i) => `<td style="text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap">${row.percents[i]?.toFixed(1) ?? "0.0"}%</td>`)
        .join("");
      return `<tr><td style="padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis" title="${_esc(row.label)}">${_esc(row.label)}</td>${cells}</tr>`;
    })
    .join("");
  return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
    <thead style="background:var(--color-surface-2,#F8F8F8)">
      <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">選択肢</th>${headerCols}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function _buildNTable(result, axisCategories, axisTotals, transpose = false) {
  if (transpose) {
    // 行=集計軸カテゴリー, 列=選択肢
    const headerCols = result.rows
      .map(row => `<th style="text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem" title="${_esc(row.label)}">${_esc(row.label)}</th>`)
      .join("");
    const rows = axisCategories
      .map((cat, ci) => {
        const cells = result.rows
          .map(row => `<td style="text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap">${row.counts[ci] ?? 0}</td>`)
          .join("");
        return `<tr><td style="padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis" title="${_esc(cat)}">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted); font-size:.75rem">n=${axisTotals[ci] ?? 0}</span></td>${cells}</tr>`;
      })
      .join("");
    return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
      <thead style="background:var(--color-surface-2,#F8F8F8)">
        <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">集計軸</th>${headerCols}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  // 通常: 行=選択肢, 列=集計軸カテゴリー
  const headerCols = axisCategories
    .map((cat, i) => `<th style="text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted)">n=${axisTotals[i] ?? 0}</span></th>`)
    .join("");
  const rows = result.rows
    .map(row => {
      const cells = axisCategories
        .map((_, i) => `<td style="text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap">${row.counts[i] ?? 0}</td>`)
        .join("");
      return `<tr><td style="padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis" title="${_esc(row.label)}">${_esc(row.label)}</td>${cells}</tr>`;
    })
    .join("");
  return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
    <thead style="background:var(--color-surface-2,#F8F8F8)">
      <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">選択肢</th>${headerCols}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function _sortedRows(rows, sortOrder) {
  if (sortOrder === "original") return rows;
  return [...rows].sort((a, b) => {
    const avgA = a.percents.reduce((s, v) => s + (v ?? 0), 0) / Math.max(a.percents.length, 1);
    const avgB = b.percents.reduce((s, v) => s + (v ?? 0), 0) / Math.max(b.percents.length, 1);
    return sortOrder === "asc" ? avgA - avgB : avgB - avgA;
  });
}

function _getSettings(questionCode, typeCode) {
  const s = AppState.step3QuestionSettings[questionCode] ?? {};
  let chartType = s.chartType ?? _recommendedType(typeCode);
  // 旧 hbar/vbar の動的マイグレーション
  if (chartType === "hbar") chartType = "bar";
  if (chartType === "vbar") chartType = "bar";
  const defaultH = ["MA", "ML", "M"].includes(typeCode);
  return {
    chartType,
    orientation:   s.orientation   ?? (defaultH ? "h" : "v"),
    showPctLabel:  s.showPctLabel  ?? true,
    sortOrder:     s.sortOrder     ?? "original",
    collapsed:     s.collapsed     ?? false,
    excluded:      s.excluded      ?? false,
    transpose:     s.transpose     ?? false,
    customColors:           s.customColors           ?? null,
    selectedPalette:        s.selectedPalette        ?? null,
    overriddenSeriesColors: s.overriddenSeriesColors ?? {},
    hiddenChoices:          s.hiddenChoices          ?? [],
    graphTitle:             s.graphTitle             ?? "",
  };
}

function _recommendedType(typeCode) {
  return RECOMMENDED_CHART[typeCode] ?? "bar";
}

function _recommendedLabel(typeCode) {
  const type = _recommendedType(typeCode);
  const base = _chartLabel(type);
  if (type === "bar") {
    const defaultH = ["MA", "ML", "M"].includes(typeCode);
    return base + (defaultH ? "（横）" : "（縦）");
  }
  return base;
}

function _chartLabel(id) {
  return CHART_TYPES.find(t => t.id === id)?.label ?? id;
}

function _getAxisCandidates() {
  const step1Codes = new Set(AppState.step1AxisCodes);
  if (!step1Codes.size) return [];
  const step2Candidates = AppState.step2AxisCandidates;
  if (step2Candidates.length) {
    const step2Codes = new Set(step2Candidates.map(c => c.question_code));
    return [...step1Codes].filter(c => step2Codes.has(c));
  }
  return [];
}

function _getAxisLabel(code) {
  const q = AppState.questions.find(q => q.question_code === code);
  return q ? (q.stub || q.question_text || code) : code;
}

function _destroyAllCharts() {
  _charts.forEach(val => {
    (Array.isArray(val) ? val : [val]).forEach(c => c.destroy());
  });
  _charts.clear();
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// カラーモーダル
// ---------------------------------------------------------------------------

function _getColorSeriesLabels(result, settings, axisCategories) {
  const { chartType, transpose } = settings;
  if (chartType === "pie")     return result.rows.map(r => r.label);
  if (chartType === "avg_bar") return axisCategories;
  if (chartType === "bar" || chartType === "stacked100")
    return transpose ? result.rows.map(r => r.label) : axisCategories;
  if (chartType === "grouped")
    return transpose ? axisCategories : result.rows.map(r => r.label);
  return axisCategories;
}

// モーダル内での色を palette + overrides から計算
function _deriveModalColors(labels) {
  const palette = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
  return labels.map((l, i) => {
    if (_colorModalOverrides[l]) return _colorModalOverrides[l];
    const fc = _fixedColorFor(l);
    if (fc) return fc;
    if (palette) { const pc = palette.colorFor(l); if (pc) return pc; }
    return COLORS[i % COLORS.length];
  });
}

function _openColorModal(idx) {
  const data = _lastCrosstabData;
  if (!data) return;
  const result   = data.results[idx];
  if (!result) return;
  const settings = _getSettings(result.question_code, result.type_code);
  const labels   = _getColorSeriesLabels(result, settings, data.axis_categories);
  _colorModalIdx    = idx;
  _colorModalLabels = labels;

  const rawSettings = AppState.step3QuestionSettings[result.question_code] ?? {};
  if ("selectedPalette" in rawSettings) {
    // 新形式: そのまま復元
    _colorModalPaletteKey = rawSettings.selectedPalette;
    _colorModalOverrides  = { ...(rawSettings.overriddenSeriesColors ?? {}) };
  } else if (rawSettings.customColors?.length > 0) {
    // 旧形式: 全色を個別上書きとして変換
    _colorModalPaletteKey = _getActiveFixedPaletteKey(labels);
    _colorModalOverrides  = Object.fromEntries(
      labels.map((l, i) => [l, rawSettings.customColors[i % rawSettings.customColors.length]])
    );
  } else {
    // 未設定: 軸レベル or 自動検出
    _colorModalPaletteKey = _getActiveFixedPaletteKey(labels);
    _colorModalOverrides  = {};
  }

  document.getElementById("step3-color-title").textContent =
    `${result.question_code}  ${result.question_text}`;
  _refreshColorModal(labels);
  document.getElementById("step3-color-modal").hidden = false;
}

function _refreshColorModal(labels) {
  const paletteEl = document.getElementById("step3-palette-btns");
  if (paletteEl) {
    const activePal = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
    const btns = FIXED_PALETTE_ORDER.map(key => {
      const p  = FIXED_PALETTES[key];
      const sw = p.preview.map(c => `<span style="background:${c}"></span>`).join("");
      const active = key === _colorModalPaletteKey ? " active" : "";
      return `<button class="step3-palette-swatch${active}" data-palette="${key}" title="${_esc(p.label)}">${sw}</button>`;
    }).join("");
    const defSw   = COLORS.slice(0, 3).map(c => `<span style="background:${c}"></span>`).join("");
    const noneBtn = `<button class="step3-palette-swatch${!_colorModalPaletteKey ? " active" : ""}" data-palette="__none__" title="デフォルト配色">${defSw}</button>`;
    const userBtns = Object.values(AppState.userPalettes ?? {}).map(entry => {
      const sw = entry.generatedColors.slice(0, 8).map(c => `<span style="background:${c}"></span>`).join("");
      const active = entry.paletteId === _colorModalPaletteKey ? " active" : "";
      return `<button class="step3-palette-swatch step3-user-palette-swatch${active}" data-palette="${entry.paletteId}" title="${_esc(entry.paletteName)}">${sw}</button>`;
    }).join("");
    const userRow = userBtns
      ? `<div class="step3-user-palette-row">${userBtns}</div>`
      : "";
    paletteEl.innerHTML = btns + noneBtn + userRow;
  }

  // 「このパレットを適用」ボタンのラベル更新
  const applyPaletteBtn = document.getElementById("step3-palette-apply-btn");
  if (applyPaletteBtn) {
    const pal = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
    applyPaletteBtn.textContent = pal ? `「${pal.label}」を適用` : "デフォルト配色を適用";
  }

  // 系列カラーピッカー（ラベルベース、ドラッグ並び替えなし）
  const colors = _deriveModalColors(labels);
  const rowsEl = document.getElementById("step3-color-rows");
  if (rowsEl) {
    rowsEl.innerHTML = colors.map((color, i) => {
      const label     = labels[i] ?? `系列${i + 1}`;
      const isCustom  = !!_colorModalOverrides[label];
      const badge     = isCustom ? `<span class="step3-custom-badge">カスタム</span>` : "";
      return `
        <div class="step3-color-row" data-ci="${i}" data-label="${_esc(label)}">
          <input type="color" class="step3-color-input" value="${color}" data-ci="${i}" data-label="${_esc(label)}">
          <span class="step3-color-label">${_esc(label)}</span>
          ${badge}
        </div>`;
    }).join("");
  }

  _refreshDragPalette();
  _refreshColorPreview(labels);
}

function _refreshColorPreview(labels) {
  const previewEl = document.getElementById("step3-color-preview");
  if (!previewEl) return;
  const colors = _deriveModalColors(labels);
  previewEl.innerHTML = colors.map((c, i) => `
    <span class="step3-preview-chip">
      <span style="background:${c}"></span>${_esc(labels[i] ?? `系列${i + 1}`)}
    </span>`).join("");
}

function _refreshDragPalette() {
  const el = document.getElementById("step3-drag-palette");
  if (!el) return;
  const colors = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey].preview : COLORS;
  el.innerHTML = colors.map(c =>
    `<span class="step3-drag-color-chip" draggable="true" data-color="${c}" style="background:${c}" title="${c}"></span>`
  ).join("");
}

function _reRenderCard(idx) {
  const data = _lastCrosstabData;
  if (!data) return;
  const result   = data.results[idx];
  if (!result) return;
  const settings = _getSettings(result.question_code, result.type_code);
  const areaEl   = document.getElementById(`step3-chart-area-${idx}`);
  if (areaEl) _renderChartInArea(areaEl, result, settings, data.axis_categories, data.axis_totals);
}

function _initColorModal() {
  const modal     = document.getElementById("step3-color-modal");
  if (!modal) return;
  const rowsEl    = document.getElementById("step3-color-rows");
  const paletteEl = document.getElementById("step3-drag-palette");

  // パレットボタンクリック → 選択状態だけ更新（即時適用しない）
  document.getElementById("step3-palette-btns")?.addEventListener("click", e => {
    const btn = e.target.closest(".step3-palette-swatch");
    if (!btn) return;
    const key = btn.dataset.palette;
    _colorModalPaletteKey = key === "__none__" ? null : key;
    _refreshColorModal(_colorModalLabels);
  });

  // 「このパレットを適用」→ 全上書きをクリアしてパレット色を一括適用
  document.getElementById("step3-palette-apply-btn")?.addEventListener("click", () => {
    _colorModalOverrides = {};
    _refreshColorModal(_colorModalLabels);
  });

  // 個別色変更 → 上書きに追加、カスタムバッジを動的付与
  rowsEl?.addEventListener("input", e => {
    const input = e.target.closest(".step3-color-input");
    if (!input) return;
    const label = input.dataset.label;
    _colorModalOverrides[label] = input.value;
    // バッジがなければ追加
    const row = input.closest(".step3-color-row");
    if (row && !row.querySelector(".step3-custom-badge")) {
      const badge = document.createElement("span");
      badge.className = "step3-custom-badge";
      badge.textContent = "カスタム";
      row.appendChild(badge);
    }
    _refreshColorPreview(_colorModalLabels);
  });

  // ドラッグ: パレットチップ
  paletteEl?.addEventListener("dragstart", e => {
    const chip = e.target.closest(".step3-drag-color-chip");
    if (!chip) return;
    _dragType  = "color";
    _dragValue = chip.dataset.color;
    e.dataTransfer.effectAllowed = "copy";
  });

  // ドラッグオーバー: 系列行
  rowsEl?.addEventListener("dragover", e => {
    if (_dragType !== "color") return;
    const row = e.target.closest(".step3-color-row");
    if (!row) return;
    e.preventDefault();
    rowsEl.querySelectorAll(".step3-color-row").forEach(r => r.classList.remove("drag-over"));
    row.classList.add("drag-over");
  });

  rowsEl?.addEventListener("dragleave", e => {
    if (!rowsEl.contains(e.relatedTarget)) {
      rowsEl.querySelectorAll(".step3-color-row").forEach(r => r.classList.remove("drag-over"));
    }
  });

  // ドロップ: 色チップ → 系列行（個別上書き）
  rowsEl?.addEventListener("drop", e => {
    e.preventDefault();
    const row = e.target.closest(".step3-color-row");
    rowsEl.querySelectorAll(".step3-color-row").forEach(r => r.classList.remove("drag-over"));
    if (!row || _dragType !== "color" || !_dragValue) {
      _dragType = null; _dragValue = null; return;
    }
    const label = row.dataset.label;
    _colorModalOverrides[label] = _dragValue;
    _dragType  = null;
    _dragValue = null;
    _refreshColorModal(_colorModalLabels);
  });

  rowsEl?.addEventListener("dragend", () => {
    rowsEl.querySelectorAll(".step3-color-row").forEach(r => r.classList.remove("drag-over"));
    _dragType  = null;
    _dragValue = null;
  });

  // 「個別変更を破棄」→ 上書きをクリア
  document.getElementById("step3-color-clear-overrides")?.addEventListener("click", () => {
    _colorModalOverrides = {};
    _refreshColorModal(_colorModalLabels);
  });

  // 「STEP1設定に戻す」→ 全カラー設定をクリア
  document.getElementById("step3-color-reset")?.addEventListener("click", () => {
    const result = _lastCrosstabData?.results[_colorModalIdx];
    if (!result) return;
    clearQuestionColorState(result.question_code);
    _reRenderCard(_colorModalIdx);
    modal.hidden = true;
  });

  // 「現在のグラフだけ変更」→ 新形式で保存
  document.getElementById("step3-color-apply-one")?.addEventListener("click", () => {
    const result = _lastCrosstabData?.results[_colorModalIdx];
    if (!result) return;
    setStep3Setting(result.question_code, "selectedPalette",        _colorModalPaletteKey);
    setStep3Setting(result.question_code, "overriddenSeriesColors",  { ..._colorModalOverrides });
    setStep3Setting(result.question_code, "customColors",            null);
    _reRenderCard(_colorModalIdx);
    modal.hidden = true;
  });

  // 「同じ集計軸すべてに適用」→ 全設問に新形式で保存
  document.getElementById("step3-color-apply-all")?.addEventListener("click", () => {
    const allResults = _lastCrosstabData?.results ?? [];
    const palette    = _colorModalPaletteKey;
    const overrides  = { ..._colorModalOverrides };
    const updates    = {};
    allResults.forEach(r => {
      updates[r.question_code] = { selectedPalette: palette, overriddenSeriesColors: overrides, customColors: null };
    });
    setStep3SettingsBulk(updates);
    allResults.forEach((_, i) => _reRenderCard(i));
    modal.hidden = true;
  });

  // キャンセル / 閉じる
  document.getElementById("step3-color-cancel")?.addEventListener("click", () => { modal.hidden = true; });
  document.getElementById("step3-color-close")?.addEventListener("click",  () => { modal.hidden = true; });
  modal.addEventListener("click", e => { if (e.target === modal) modal.hidden = true; });
}

// ---------------------------------------------------------------------------
// 新規パレット生成セクション
// ---------------------------------------------------------------------------

function _initGenPaletteSection() {
  const section = document.getElementById("step3-gen-palette-section");
  if (!section) return;

  // プレビュー更新ヘルパー
  function _updateGenPreview() {
    const keyColor  = document.getElementById("gen-key-color")?.value ?? "#0071BC";
    const count     = parseInt(document.getElementById("gen-color-count")?.value ?? "6", 10);
    const stepPct   = parseInt(document.getElementById("gen-brightness-step")?.value ?? "10", 10);
    const pattern   = document.getElementById("gen-pattern")?.value ?? "center";
    const finePct   = parseInt(document.getElementById("gen-brightness-fine")?.value ?? "0", 10);
    const satPct    = parseInt(document.getElementById("gen-saturation")?.value ?? "0", 10);

    const colors = _generatePaletteColors(keyColor, count, stepPct, pattern, finePct, satPct);
    const previewEl = document.getElementById("gen-palette-preview");
    if (previewEl) {
      previewEl.innerHTML = colors
        .map(c => `<span class="step3-gen-preview-chip" style="background:${c}" title="${c}"></span>`)
        .join("");
    }
    return colors;
  }

  // スライダーの表示値同期ヘルパー
  function _syncSliderVal(inputId, valId, suffix = "%") {
    const input = document.getElementById(inputId);
    const val   = document.getElementById(valId);
    if (!input || !val) return;
    input.addEventListener("input", () => { val.textContent = input.value + suffix; _updateGenPreview(); });
  }

  // カラーピッカーの hex 表示同期
  const keyColorInput = document.getElementById("gen-key-color");
  const keyColorHex   = document.getElementById("gen-key-color-hex");
  keyColorInput?.addEventListener("input", () => {
    if (keyColorHex) keyColorHex.textContent = keyColorInput.value;
    _updateGenPreview();
  });

  // 色数・パターン変化でもプレビュー更新
  document.getElementById("gen-color-count")?.addEventListener("input", _updateGenPreview);
  document.getElementById("gen-pattern")?.addEventListener("change", _updateGenPreview);

  _syncSliderVal("gen-brightness-step", "gen-brightness-step-val");
  _syncSliderVal("gen-brightness-fine", "gen-brightness-fine-val");
  _syncSliderVal("gen-saturation",      "gen-saturation-val");

  // 初回プレビュー
  _updateGenPreview();

  // パレット追加（保存のみ）
  document.getElementById("gen-palette-add-btn")?.addEventListener("click", () => {
    const colors = _updateGenPreview();
    if (!colors.length) return;
    const entry = _buildUserPaletteEntry(colors);
    addUserPalette(entry);
    _refreshColorModal(_colorModalLabels);
  });

  // このグラフに適用（追加 + 選択 + 適用 + 保存）
  document.getElementById("gen-palette-apply-one-btn")?.addEventListener("click", () => {
    const result = _lastCrosstabData?.results[_colorModalIdx];
    if (!result) return;
    const colors = _updateGenPreview();
    if (!colors.length) return;
    const entry = _buildUserPaletteEntry(colors);
    addUserPalette(entry);
    _colorModalPaletteKey = entry.paletteId;
    _colorModalOverrides  = {};
    setStep3Setting(result.question_code, "selectedPalette",        entry.paletteId);
    setStep3Setting(result.question_code, "overriddenSeriesColors",  {});
    setStep3Setting(result.question_code, "customColors",            null);
    _reRenderCard(_colorModalIdx);
    _refreshColorModal(_colorModalLabels);
  });

  // 全グラフに適用
  document.getElementById("gen-palette-apply-all-btn")?.addEventListener("click", () => {
    const allResults = _lastCrosstabData?.results ?? [];
    const colors = _updateGenPreview();
    if (!colors.length) return;
    const entry = _buildUserPaletteEntry(colors);
    addUserPalette(entry);
    _colorModalPaletteKey = entry.paletteId;
    _colorModalOverrides  = {};
    const updates = {};
    allResults.forEach(r => {
      updates[r.question_code] = { selectedPalette: entry.paletteId, overriddenSeriesColors: {}, customColors: null };
    });
    setStep3SettingsBulk(updates);
    allResults.forEach((_, i) => _reRenderCard(i));
    _refreshColorModal(_colorModalLabels);
  });

  // STEP1 設定に登録
  document.getElementById("gen-palette-step1-btn")?.addEventListener("click", () => {
    const colors = _updateGenPreview();
    if (!colors.length) return;
    const entry = _buildUserPaletteEntry(colors);
    addUserPalette(entry);
    if (AppState.step3ActiveAxisCode) {
      setStep1FixedPalette(AppState.step3ActiveAxisCode, entry.paletteId);
    }
    _refreshColorModal(_colorModalLabels);
  });
}

function _buildUserPaletteEntry(colors) {
  const keyColor = document.getElementById("gen-key-color")?.value ?? "#0071BC";
  const count    = parseInt(document.getElementById("gen-color-count")?.value ?? "6", 10);
  const stepPct  = parseInt(document.getElementById("gen-brightness-step")?.value ?? "10", 10);
  const pattern  = document.getElementById("gen-pattern")?.value ?? "center";
  const finePct  = parseInt(document.getElementById("gen-brightness-fine")?.value ?? "0", 10);
  const satPct   = parseInt(document.getElementById("gen-saturation")?.value ?? "0", 10);
  const rawName  = (document.getElementById("gen-palette-name")?.value ?? "").trim();
  const name     = rawName || `${keyColor}_${count}色`;
  const paletteId = `custom_${Date.now()}`;
  return {
    paletteId,
    paletteName:         name,
    keyColor,
    generatedColors:     colors,
    colorCount:          count,
    brightnessStepPct:   stepPct,
    brightnessPattern:   pattern,
    brightnessFinePct:   finePct,
    satAdjPct:           satPct,
    createdAt:           new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// エクスポートモジュール向けに utility を公開
// ---------------------------------------------------------------------------
export { _sortedRows          as sortedRows };
export { _getSettings         as getSettings };
export { _getColorsForGraph   as getColorsForGraph };
export { _getColorSeriesLabels as getColorSeriesLabels };
export function getLastCrosstabData() { return _lastCrosstabData; }
export function getCharts() { return _charts; }

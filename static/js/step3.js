/**
 * STEP3: クロス集計・グラフ作成パネル。
 *
 * 設問ごとに棒グラフ向き・%ラベル・ソート・折りたたみ・除外を設定可能。
 * 設定は AppState.step3QuestionSettings に保持してプロジェクト保存対象。
 */
import { AppState, setStep3ActiveAxis, setStep3SecondaryAxis, setStep3CompositeDisplayMode, setStep3ColorPriority, setStep3MinSampleSize, setStep3Setting, setStep3SettingsBulk, setStep1FixedPalette, clearQuestionColorState, clearQuestionColorStateBulk, addUserPalette, setStep3ActiveSetId, setStep3ActiveViewId, setStep3TargetFilterColumn, setStep3TargetFilterValues, getTargetValues, addChartResults, addChartResultsAsReportPages, addReportPageFromStep3, overwriteReportPageFromStep3, findDuplicateReportPage, setActivePanel, setStep3Mode, setStep3BasicAxis, setStep3ComparisonAxis, setStep3DeepDiveTarget, setStep3QuestionPageMode, setStep3SelectedQuestionCodes } from "./state.js";

import { generateCrosstab } from "./api.js";
import { yieldToMain, showToast } from "./app.js";
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
  SL: "bar",
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
const _MATRIX_SUIT = { bar:"recommended", stacked100:"recommended", grouped:"recommended", radar:"recommended",
                       pie:"not_recommended", line:"available", scatter:"not_recommended",
                       avg_bar:"not_recommended", table_only:"available" };
const CHART_SUITABILITY = {
  SA: _SA_SUIT, S: _SA_SUIT,
  MA: _MA_SUIT, ML: _MA_SUIT, M: _MA_SUIT,
  NU: _NU_SUIT, N: _NU_SUIT,
  SL: _MATRIX_SUIT,
};

function _chartSuitability(chartId, typeCode) {
  return (CHART_SUITABILITY[typeCode] ?? {})[chartId] ?? "available";
}

// 向き選択が有効なチャートタイプ
const ORIENTATION_TYPES = new Set(["bar", "stacked100", "grouped"]);

// 棒の太さ調整が有効なチャートタイプ
const BAR_WIDTH_TYPES = new Set(["bar", "stacked100", "grouped", "avg_bar"]);

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
    canonicalValues: [
      { label: "コアファン",       color: "#FF5050" },
      { label: "ファン",           color: "#FF9999" },
      { label: "ライトファン",     color: "#FFCCCC" },
      { label: "非ファン",         color: "#BFBFBF" },
    ],
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
    canonicalValues: [
      { label: "男性", color: "#1D4ED8" },
      { label: "女性", color: "#DB2777" },
    ],
    colorFor(label) {
      if (/^男($|性)/.test(label)) return "#1D4ED8";
      if (/^女($|性)/.test(label)) return "#DB2777";
      return null;
    },
  },
  age_gender: {
    label: "性年代パレットA",
    preview: ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A","#FBCFE8","#F9A8D4","#F472B6","#EC4899","#DB2777","#9D174D"],
    canonicalValues: [
      { label: "男性10代", color: "#BFDBFE" }, { label: "男性20代", color: "#93C5FD" },
      { label: "男性30代", color: "#60A5FA" }, { label: "男性40代", color: "#3B82F6" },
      { label: "男性50代", color: "#1D4ED8" }, { label: "男性60代", color: "#1E3A8A" },
      { label: "女性10代", color: "#FBCFE8" }, { label: "女性20代", color: "#F9A8D4" },
      { label: "女性30代", color: "#F472B6" }, { label: "女性40代", color: "#EC4899" },
      { label: "女性50代", color: "#DB2777" }, { label: "女性60代", color: "#9D174D" },
    ],
    colorFor(label) {
      const gm = label.match(/(男性|女性)/);
      if (!gm) return null;
      const dm = label.match(/(\d+)代/) ?? label.match(/(\d+)[-~〜]\d+歳?/);
      if (!dm) return null;
      const d = parseInt(dm[1]);
      const male   = {10:"#BFDBFE",20:"#93C5FD",30:"#60A5FA",40:"#3B82F6",50:"#1D4ED8",60:"#1E3A8A"};
      const female = {10:"#FBCFE8",20:"#F9A8D4",30:"#F472B6",40:"#EC4899",50:"#DB2777",60:"#9D174D"};
      return (gm[1] === "男性" ? male : female)[d] ?? null;
    },
  },
  age_a: {
    label: "年代別パレットA",
    preview: ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
    canonicalValues: [
      { label: "10代", color: "#BFDBFE" }, { label: "20代", color: "#93C5FD" },
      { label: "30代", color: "#60A5FA" }, { label: "40代", color: "#3B82F6" },
      { label: "50代", color: "#1D4ED8" }, { label: "60代", color: "#1E3A8A" },
    ],
    colorFor(label) {
      const m = label.match(/(\d+)代/) ?? label.match(/(\d+)[-~〜]\d+歳?/);
      if (!m) return null;
      const map = {10:"#BFDBFE",20:"#93C5FD",30:"#60A5FA",40:"#3B82F6",50:"#1D4ED8",60:"#1E3A8A"};
      return map[parseInt(m[1])] ?? null;
    },
  },
  age_b: {
    label: "年代別パレットB",
    preview: ["#D1FAE5","#A7F3D0","#6EE7B7","#34D399","#10B981","#065F46"],
    canonicalValues: [
      { label: "10代", color: "#D1FAE5" }, { label: "20代", color: "#A7F3D0" },
      { label: "30代", color: "#6EE7B7" }, { label: "40代", color: "#34D399" },
      { label: "50代", color: "#10B981" }, { label: "60代", color: "#065F46" },
    ],
    colorFor(label) {
      const m = label.match(/(\d+)代/) ?? label.match(/(\d+)[-~〜]\d+歳?/);
      if (!m) return null;
      const map = {10:"#D1FAE5",20:"#A7F3D0",30:"#6EE7B7",40:"#34D399",50:"#10B981",60:"#065F46"};
      return map[parseInt(m[1])] ?? null;
    },
  },
  age_c: {
    label: "年代別パレットC",
    preview: ["#FEF3C7","#FDE68A","#FCD34D","#FBBF24","#F59E0B","#B45309"],
    canonicalValues: [
      { label: "10代", color: "#FEF3C7" }, { label: "20代", color: "#FDE68A" },
      { label: "30代", color: "#FCD34D" }, { label: "40代", color: "#FBBF24" },
      { label: "50代", color: "#F59E0B" }, { label: "60代", color: "#B45309" },
    ],
    colorFor(label) {
      const m = label.match(/(\d+)代/) ?? label.match(/(\d+)[-~〜]\d+歳?/);
      if (!m) return null;
      const map = {10:"#FEF3C7",20:"#FDE68A",30:"#FCD34D",40:"#FBBF24",50:"#F59E0B",60:"#B45309"};
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
  "__none__": {
    label: "なし（グレー）",
    preview: ["#676767"],
    generatedColors: ["#676767"],
    colorFor: () => "#676767",
  },
};
const FIXED_PALETTE_ORDER = ["fan_label","gender","age_gender","age_a","age_b","age_c","scale_67","scale_1011"];

function _detectFixedPaletteFromLabels(labels) {
  if (labels.some(l => /コアファン/.test(l)) && labels.some(l => /ライトファン/.test(l)))
    return "fan_label";
  if (labels.some(l => /(男性|女性)\d+代/.test(l)) || labels.some(l => /\d+代(男性|女性)/.test(l)) ||
      labels.some(l => /(男性|女性)\d+[-~〜]\d+/.test(l)))
    return "age_gender";
  if (labels.some(l => /^男($|性)/.test(l)) || labels.some(l => /^女($|性)/.test(l)))
    return "gender";
  if (labels.some(l => /\d+代/.test(l)) || labels.some(l => /\d+[-~〜]\d+歳/.test(l)))
    return "age_c";
  if (labels.some(l => /High[1-5]|TOP[23]/.test(l)) && labels.some(l => /Low[1-5]/.test(l)))
    return labels.length > 7 ? "scale_1011" : "scale_67";
  return "__none__";
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
// 複合軸カラーモード: null ならデフォルト。配列を設定すると _getColorsForGraph のパレット検索に使用する
let _compositeColorPaletteLookup = null;
// カラーモーダル状態
let _colorModalIdx          = null;
let _colorModalLabels       = [];    // 現在の系列ラベル配列
let _colorModalPaletteKey   = null;  // モーダル内選択中パレットキー
let _colorModalOverrides    = {};    // { label: hex } 個別上書き
let _colorModalValueMapping = null;  // [{label, color}] | null 値↔色対応（編集中作業コピー）
// ドラッグ状態（"color" | null）
let _dragType  = null;
let _dragValue = null;

// ---------------------------------------------------------------------------
// 設問セット段階的生成: キャッシュ・遅延描画
// ---------------------------------------------------------------------------

const _crosstabCache = {};              // { cacheKey: CrosstabResponse }
const _pendingChartRenders = new Map(); // { DOMElement: renderFn }
let   _chartObserver = null;
let   _currentCacheKey = "";            // 現在表示中のキャッシュキー

export function getCrosstabCache() { return { ..._crosstabCache }; }
export function setCrosstabCache(cache) { Object.assign(_crosstabCache, cache ?? {}); }

export function resetStep3UI() {
  _destroyAllCharts();
  _clearPendingChartRenders();
  _lastCrosstabData = null;
  _compositeColorPaletteLookup = null;
  _colorModalIdx = null;
  _colorModalLabels = [];
  _colorModalPaletteKey = null;
  _colorModalOverrides = {};
  _colorModalValueMapping = null;
  _dragType = null;
  _dragValue = null;
  _currentCacheKey = "";
  Object.keys(_crosstabCache).forEach(k => delete _crosstabCache[k]);

  const nav = document.getElementById("step3-sidebar-nav");
  if (nav) nav.innerHTML = "";
  const viewPanel = document.getElementById("step3-view-panel");
  if (viewPanel) viewPanel.innerHTML = "";
  const progress = document.getElementById("step3-progress");
  if (progress) progress.style.display = "none";
  const resultsEl = document.getElementById("step3-results");
  if (resultsEl) {
    resultsEl.innerHTML =
      '<div id="step3-placeholder" style="text-align:center; padding:80px 0; color:var(--color-text-muted); font-size:1rem">設定を選択して「グラフ生成」を押してください</div>';
  }
}

function _getCacheKey(axisCode, secAxisCode, setId) {
  const col  = AppState.step3TargetFilterColumn;
  const vals = AppState.step3TargetFilterValues;
  const filterKey = col ? `${col}:${[...vals].sort().join(",")}` : "";
  return `${axisCode}||${secAxisCode || ""}||${setId}||${filterKey}`;
}

function _initLazyChartObserver() {
  _chartObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const fn = _pendingChartRenders.get(entry.target);
      if (fn) { fn(); _pendingChartRenders.delete(entry.target); }
      _chartObserver.unobserve(entry.target);
    }
  }, { rootMargin: "200px" });
}

function _scheduleChartRender(areaEl, renderFn) {
  if (!_chartObserver) { renderFn(); return; }
  _pendingChartRenders.set(areaEl, renderFn);
  _chartObserver.observe(areaEl);
}

function _clearPendingChartRenders() {
  if (_chartObserver) {
    _pendingChartRenders.forEach((_, el) => _chartObserver.unobserve(el));
  }
  _pendingChartRenders.clear();
}

// ラベルの年代表記を正規化（例: "20-29歳" → "20代"）
function _normalizeAgeLabel(s) {
  return s.replace(/(\d+)[-~〜]\d+歳?/g, (_, d) => `${parseInt(d)}代`).trim();
}

// valueColorMapping に対するファジーマッチング
function _matchValueColorMapping(label, mapping) {
  if (!mapping?.length) return null;
  let m = mapping.find(e => e.label === label);
  if (m) return m.color;
  const n = _normalizeAgeLabel(label);
  m = mapping.find(e => _normalizeAgeLabel(e.label) === n);
  if (m) return m.color;
  m = mapping.find(e => label.includes(e.label) || e.label.includes(label));
  return m?.color ?? null;
}

// 色解決：個別上書き > 固定カラー > valueColorMapping(ファジー) > 選択パレット > STEP1軸パレット > COLORSデフォルト
// _compositeColorPaletteLookup が設定されている場合、パレット検索にはそのラベルを使用する
function _getColorsForGraph(questionCode, labels) {
  const _viewId = AppState.step3ActiveViewId;
  const _view   = AppState.step3Views?.[_viewId];
  const s = _view?.questionSettings?.[questionCode]
    ?? AppState.step3QuestionSettings[questionCode]
    ?? {};

  // 旧形式: selectedPalette キーがなく customColors が存在 → 旧パスにフォールバック
  if (!("selectedPalette" in s) && s.customColors?.length > 0) {
    return labels.map((_, i) => s.customColors[i % s.customColors.length]);
  }

  const overrides = s.overriddenSeriesColors ?? {};
  const vm = s.valueColorMapping ?? null;
  const lookupLabels = _compositeColorPaletteLookup ?? labels;
  const paletteKey = "selectedPalette" in s
    ? s.selectedPalette
    : _getActiveFixedPaletteKey(lookupLabels);
  const palette = paletteKey
    ? (FIXED_PALETTES[paletteKey] ?? _getUserPaletteObj(paletteKey))
    : null;

  return labels.map((l, i) => {
    if (overrides[l]) return overrides[l];
    const fc = _fixedColorFor(l);
    if (fc) return fc;
    const ll = lookupLabels[i] ?? l;
    const mc = _matchValueColorMapping(ll, vm);
    if (mc) return mc;
    if (palette) {
      if (palette.generatedColors) {
        return palette.generatedColors[i % palette.generatedColors.length];
      }
      const pc = palette.colorFor(ll);
      if (pc) return pc;
    }
    // 旧プロジェクト互換: fixedPalette:null / selectedPalette:null は "なし（グレー）" 扱い
    const axisEntry = AppState.step1AxisColors?.[AppState.step3ActiveAxisCode];
    const isStep1ExplicitNone = axisEntry && "fixedPalette" in axisEntry && axisEntry.fixedPalette === null;
    const isStep3ExplicitNone = "selectedPalette" in s && s.selectedPalette === null;
    if (isStep1ExplicitNone || isStep3ExplicitNone) return "#676767";
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

  _initLazyChartObserver();
  document.addEventListener("survey:statechange", _onStateChange);
  // イベント委譲: results コンテナに1度だけ登録
  const resultsEl = document.getElementById("step3-results");
  if (resultsEl) {
    resultsEl.addEventListener("change", _onResultsChange);
    resultsEl.addEventListener("click",  _onResultsClick);
    resultsEl.addEventListener("input",  _onResultsInput);
  }

  // サイドバー初期化
  _initSidebar();

  // カラーモーダル初期化
  _initColorModal();
  _initGenPaletteSection();
}

// ---------------------------------------------------------------------------
// 状態変化ハンドラ
// ---------------------------------------------------------------------------

function _onStateChange() {
  if (AppState.activePanel !== "step3") return;
  _renderModeCard();
  _renderConfigCard();
  _renderViewPanel();
  _renderSidebar();
}

// ---------------------------------------------------------------------------
// セクション0-A: 分析モード管理
// ---------------------------------------------------------------------------

function _renderModeCard() {
  const card = document.getElementById("step3-mode-card");
  if (!card) return;

  card.querySelectorAll(".step3-mode-tab").forEach(btn => {
    const active = btn.dataset.mode === AppState.step3Mode;
    btn.classList.toggle("active", active);
  });

  if (!card._modeInitialized) {
    card._modeInitialized = true;
    card.querySelectorAll(".step3-mode-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        setStep3Mode(btn.dataset.mode);
      });
    });
  }
}

function _renderConfigCard() {
  const mode = AppState.step3Mode || "brand_comparison";
  const panels = ["brand_comparison", "deep_dive", "question_comparison"];
  panels.forEach(m => {
    const el = document.getElementById(`step3-panel-${m}`);
    if (el) el.hidden = (m !== mode);
  });

  if (mode === "brand_comparison") _renderBrandComparisonPanel();
  else if (mode === "deep_dive") _renderDeepDivePanel();
  else _renderQuestionComparisonPanel();
}

// ---------------------------------------------------------------------------
// セクション0-B: ブランド比較パネル
// ---------------------------------------------------------------------------

function _buildAxisSelectOptions(candidates, selectedCode, includeNone, noneLabel) {
  const noneOpt = includeNone
    ? `<option value="">${_esc(noneLabel ?? "（なし）")}</option>`
    : "";
  const opts = candidates.map(code => {
    const { text, badge } = _getAxisSelectorLabel(code);
    const label = `${code}　${text}　[${badge}]`;
    return `<option value="${_esc(code)}"${code === selectedCode ? " selected" : ""}>${_esc(label)}</option>`;
  }).join("");
  return noneOpt + opts;
}

function _buildQuestionCheckboxes(containerId, questionCodes, selectedCodes) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const selectedSet = new Set(selectedCodes);
  const qMap = Object.fromEntries((AppState.questions ?? []).map(q => [q.question_code, q]));
  if (!questionCodes.length) {
    el.innerHTML = `<div style="color:var(--color-text-muted); font-size:.82rem; padding:4px 0">
      左のサイドバーから集計セットを選択してください</div>`;
    return;
  }
  el.innerHTML = questionCodes.map(code => {
    const q = qMap[code];
    const label = q ? `${code}　${q.question_text ?? ""}` : code;
    return `<label class="step3-question-cb-item">
      <input type="checkbox" value="${_esc(code)}"${selectedSet.has(code) ? " checked" : ""}>
      <span>${_esc(label)}</span>
    </label>`;
  }).join("");

  el.addEventListener("change", e => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    const cur = new Set(AppState.step3SelectedQuestionCodes);
    cb.checked ? cur.add(cb.value) : cur.delete(cb.value);
    setStep3SelectedQuestionCodes([...cur]);
  }, { once: false, passive: true });
}

function _renderBrandComparisonPanel() {
  const candidates = _getAxisCandidates();

  // 基本軸
  const basicSel = document.getElementById("step3-basic-axis-select");
  if (basicSel) {
    basicSel.innerHTML = _buildAxisSelectOptions(candidates, AppState.step3BasicAxisCode, true, "（未選択）");
    if (!basicSel._basicInitialized) {
      basicSel._basicInitialized = true;
      basicSel.addEventListener("change", () => setStep3BasicAxis(basicSel.value));
    }
  }

  // 比較軸（基本軸を除いた候補）
  const compCandidates = candidates.filter(c => c !== AppState.step3BasicAxisCode);
  const compSel = document.getElementById("step3-comparison-axis-select");
  if (compSel) {
    compSel.innerHTML = _buildAxisSelectOptions(compCandidates, AppState.step3ComparisonAxisCode, true, "（なし）");
    if (!compSel._compInitialized) {
      compSel._compInitialized = true;
      compSel.addEventListener("change", () => setStep3ComparisonAxis(compSel.value));
    }
  }

  // 絞り込み条件（既存のフィルタUIを流用）
  _renderTargetFilterSection();

  // 集計対象設問
  const activeCodes = _getActiveSetQuestionCodes();
  const selected = AppState.step3SelectedQuestionCodes;
  _buildQuestionCheckboxes("step3-question-checkboxes", activeCodes, selected);

  // グラフ生成ボタン
  const genBtn = document.getElementById("step3-generate-btn");
  if (genBtn && !genBtn._genInitialized) {
    genBtn._genInitialized = true;
    genBtn.addEventListener("click", () => _runStep3());
  }
}

// ---------------------------------------------------------------------------
// セクション0-C: 特定対象深掘りパネル
// ---------------------------------------------------------------------------

let _diveFilerColumnChoices = [];

function _renderDeepDivePanel() {
  const candidates = _getAxisCandidates();

  // 基本軸
  const basicSel = document.getElementById("step3-dive-basic-axis-select");
  if (basicSel) {
    basicSel.innerHTML = _buildAxisSelectOptions(candidates, AppState.step3BasicAxisCode, true, "（未選択）");
    if (!basicSel._diveBasicInitialized) {
      basicSel._diveBasicInitialized = true;
      basicSel.addEventListener("change", () => {
        setStep3BasicAxis(basicSel.value);
        setStep3DeepDiveTarget("");
      });
    }
  }

  // 対象（基本軸の選択肢）
  const targetSel = document.getElementById("step3-dive-target-select");
  if (targetSel) {
    const basicCode = AppState.step3BasicAxisCode;
    const choices = basicCode ? getTargetValues(basicCode) : [];
    targetSel.disabled = !basicCode;
    targetSel.innerHTML = basicCode
      ? [`<option value="">（対象を選択）</option>`,
         ...choices.map(v => `<option value="${_esc(v)}"${v === AppState.step3DeepDiveTarget ? " selected" : ""}>${_esc(v)}</option>`)
        ].join("")
      : `<option value="">（基本軸を先に選択）</option>`;
    if (!targetSel._diveTargetInitialized) {
      targetSel._diveTargetInitialized = true;
      targetSel.addEventListener("change", () => setStep3DeepDiveTarget(targetSel.value));
    }
  }

  // 比較軸（基本軸を除いた候補）
  const compCandidates = candidates.filter(c => c !== AppState.step3BasicAxisCode);
  const compSel = document.getElementById("step3-dive-comparison-axis-select");
  if (compSel) {
    compSel.innerHTML = _buildAxisSelectOptions(compCandidates, AppState.step3ComparisonAxisCode, true, "（未選択）");
    if (!compSel._diveCompInitialized) {
      compSel._diveCompInitialized = true;
      compSel.addEventListener("change", () => setStep3ComparisonAxis(compSel.value));
    }
  }

  // 絞り込み（追加フィルタ — diveモード専用列）
  const diveFilterSel = document.getElementById("step3-dive-filter-column");
  if (diveFilterSel) {
    const diveFilterCode = diveFilterSel.value;
    diveFilterSel.innerHTML = `<option value="">（絞り込みなし）</option>` +
      candidates.filter(c => c !== AppState.step3BasicAxisCode && c !== AppState.step3ComparisonAxisCode)
        .map(code => {
          const { text } = _getAxisSelectorLabel(code);
          return `<option value="${_esc(code)}"${code === diveFilterCode ? " selected" : ""}>${_esc(code)}　${_esc(text)}</option>`;
        }).join("");
    const diveFilterValSec = document.getElementById("step3-dive-filter-values-section");
    const diveFilterValList = document.getElementById("step3-dive-filter-values-list");
    if (!diveFilterSel._diveFilterInitialized) {
      diveFilterSel._diveFilterInitialized = true;
      diveFilterSel.addEventListener("change", () => {
        _diveFilerColumnChoices = getTargetValues(diveFilterSel.value);
        if (diveFilterValSec) diveFilterValSec.style.display = diveFilterSel.value ? "" : "none";
        if (diveFilterValList && diveFilterSel.value) {
          diveFilterValList.innerHTML = _diveFilerColumnChoices.map(v =>
            `<label class="step3-target-cb-item"><input type="checkbox" value="${_esc(v)}"><span>${_esc(v)}</span></label>`
          ).join("");
        }
      });
    }
  }

  // 集計対象設問
  const activeCodes = _getActiveSetQuestionCodes();
  const selected = AppState.step3SelectedQuestionCodes;
  _buildQuestionCheckboxes("step3-dive-question-checkboxes", activeCodes, selected);

  // 生成ボタン
  const genBtn = document.getElementById("step3-dive-generate-btn");
  if (genBtn && !genBtn._diveGenInitialized) {
    genBtn._diveGenInitialized = true;
    genBtn.addEventListener("click", () => _runStep3());
  }
}

// ---------------------------------------------------------------------------
// セクション0-D: 設問比較パネル
// ---------------------------------------------------------------------------

function _renderQuestionComparisonPanel() {
  const candidates = _getAxisCandidates();

  // 集計軸（オプション）
  const qcompAxisSel = document.getElementById("step3-qcomp-axis-select");
  if (qcompAxisSel) {
    qcompAxisSel.innerHTML = _buildAxisSelectOptions(candidates, AppState.step3BasicAxisCode, true, "（なし — 全体集計）");
    if (!qcompAxisSel._qcompInitialized) {
      qcompAxisSel._qcompInitialized = true;
      qcompAxisSel.addEventListener("change", () => setStep3BasicAxis(qcompAxisSel.value));
    }
  }

  // 集計対象設問（全セット or アクティブセット）
  const activeCodes = _getActiveSetQuestionCodes();
  const selected = AppState.step3SelectedQuestionCodes;
  _buildQuestionCheckboxes("step3-qcomp-question-checkboxes", activeCodes, selected);

  // ページ生成方式ラジオ
  const pageMode = AppState.step3QuestionPageMode || "per_question";
  document.querySelectorAll("input[name='step3-page-mode']").forEach(radio => {
    radio.checked = (radio.value === pageMode);
    if (!radio._pageModeInitialized) {
      radio._pageModeInitialized = true;
      radio.addEventListener("change", () => {
        if (radio.checked) setStep3QuestionPageMode(radio.value);
      });
    }
  });

  // 生成ボタン
  const genBtn = document.getElementById("step3-qcomp-generate-btn");
  if (genBtn && !genBtn._qcompGenInitialized) {
    genBtn._qcompGenInitialized = true;
    genBtn.addEventListener("click", () => _runStep3());
  }
}

// ---------------------------------------------------------------------------
// セクション0-E: アクティブセット設問コード取得
// ---------------------------------------------------------------------------

function _getActiveSetQuestionCodes() {
  const activeSetId = AppState.step3ActiveSetId;
  const excluded = new Set(AppState.excludedQuestionCodes);
  if (!activeSetId) return [];

  let set = AppState.questionSets.find(s => s.setId === activeSetId);
  if (!set) {
    for (const parent of AppState.questionSets) {
      const child = (parent.children ?? []).find(c => c.setId === activeSetId);
      if (child) { set = child; break; }
    }
  }
  return (set?.questionCodes ?? []).filter(c => !excluded.has(c));
}

// ---------------------------------------------------------------------------
// セクション0: 絞り込みフィルタ（旧セクション0 — ブランド比較モードで流用）
// ---------------------------------------------------------------------------

let _filterColumnChoices = [];  // 現在の対象列の選択肢リスト（全件）

function _renderTargetFilterSection() {
  const colSel   = document.getElementById("step3-target-column");
  const valSec   = document.getElementById("step3-target-values-section");
  const valList  = document.getElementById("step3-target-values-list");
  const valCount = document.getElementById("step3-target-values-count");
  const badge    = document.getElementById("step3-filter-badge-brand");
  if (!colSel) return;

  const candidates = _getAxisCandidates();

  const colOptions = candidates.map(code => {
    const { text, badge: typeBadge } = _getAxisSelectorLabel(code);
    return `<option value="${_esc(code)}" ${code === AppState.step3TargetFilterColumn ? "selected" : ""}>${_esc(code)}　${_esc(text)}　[${_esc(typeBadge)}]</option>`;
  }).join("");
  colSel.innerHTML = `<option value="">（絞り込みなし — 全回答者）</option>${colOptions}`;

  if (!colSel._filterInitialized) {
    colSel._filterInitialized = true;

    colSel.addEventListener("change", () => {
      setStep3TargetFilterColumn(colSel.value);
      _renderTargetFilterSection();
    });

    document.getElementById("step3-target-all-btn")?.addEventListener("click", () => {
      const searchEl  = document.getElementById("step3-target-value-search");
      const st = (searchEl?.value ?? "").toLowerCase().trim();
      const visible2  = st ? _filterColumnChoices.filter(v => v.toLowerCase().includes(st)) : _filterColumnChoices;
      const prevSel   = new Set(AppState.step3TargetFilterValues);
      visible2.forEach(v => prevSel.add(v));
      setStep3TargetFilterValues([...prevSel]);
      _renderTargetFilterSection();
    });

    document.getElementById("step3-target-none-btn")?.addEventListener("click", () => {
      setStep3TargetFilterValues([]);
      _renderTargetFilterSection();
    });

    document.getElementById("step3-target-value-search")?.addEventListener("input", () => {
      _renderTargetFilterSection();
    });

    document.getElementById("step3-target-values-list")?.addEventListener("change", e => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      const cur = new Set(AppState.step3TargetFilterValues);
      cb.checked ? cur.add(cb.value) : cur.delete(cb.value);
      setStep3TargetFilterValues([...cur]);
      _renderTargetFilterSection();
    });
  }

  const selectedCol = AppState.step3TargetFilterColumn;
  if (!selectedCol || !candidates.includes(selectedCol)) {
    if (valSec) valSec.style.display = "none";
    if (badge) badge.hidden = true;
    return;
  }

  if (valSec) valSec.style.display = "";

  _filterColumnChoices = getTargetValues(selectedCol);

  const selected = new Set(AppState.step3TargetFilterValues);

  const searchInput = document.getElementById("step3-target-value-search");
  const searchTerm  = (searchInput?.value ?? "").toLowerCase().trim();
  const visible     = searchTerm
    ? _filterColumnChoices.filter(v => v.toLowerCase().includes(searchTerm))
    : _filterColumnChoices;

  if (valList) {
    valList.innerHTML = visible.map(v => `
      <label class="step3-target-cb-item">
        <input type="checkbox" value="${_esc(v)}" ${selected.has(v) ? "checked" : ""}>
        <span>${_esc(v)}</span>
      </label>`).join("");
  }

  if (valCount) {
    valCount.textContent = selected.size
      ? `（${selected.size}件選択中 / 全${_filterColumnChoices.length}件）`
      : `（全${_filterColumnChoices.length}件）`;
  }

  if (badge) badge.hidden = selected.size === 0;
}

// ---------------------------------------------------------------------------
// セクション1: 検索可能ドロップダウン軸セレクター
// ---------------------------------------------------------------------------

function _renderAxisSelector() {
  const searchInput   = document.getElementById("step3-axis-search");
  const axisSelect    = document.getElementById("step3-axis-select");
  const el2           = document.getElementById("step3-secondary-axis-wrapper");
  const compositeCtrl = document.getElementById("step3-composite-controls");
  if (!axisSelect) return;

  const candidates = _getAxisCandidates();

  if (!candidates.length) {
    const hasStep2 = Boolean(AppState.step2Filename);
    const msg = hasStep2
      ? "集計軸候補がありません。回答データの列と設問コードを確認してください。"
      : "STEP2 で回答データをアップロードしてください。";
    axisSelect.innerHTML = `<option value="" disabled>${_esc(msg)}</option>`;
    if (searchInput) searchInput.value = "";
    if (el2) el2.innerHTML = "";
    if (compositeCtrl) compositeCtrl.style.display = "none";
    return;
  }

  // 現在の選択を維持 or デフォルト
  let currentCode = AppState.step3ActiveAxisCode;
  if (!candidates.includes(currentCode)) {
    currentCode = candidates[0];
    setStep3ActiveAxis(currentCode);
  }

  // 検索フィルタ適用
  const searchTerm = (searchInput?.value ?? "").toLowerCase().trim();
  const filtered   = searchTerm
    ? candidates.filter(c => {
        const { text } = _getAxisSelectorLabel(c);
        return c.toLowerCase().includes(searchTerm) || text.toLowerCase().includes(searchTerm);
      })
    : candidates;

  axisSelect.innerHTML = filtered.map(code => {
    const { text, badge } = _getAxisSelectorLabel(code);
    const label = `${code}　${text}　[${badge}]`;
    return `<option value="${_esc(code)}"${code === currentCode ? " selected" : ""}>${_esc(label)}</option>`;
  }).join("") || `<option value="" disabled>（検索結果なし）</option>`;

  // イベントを一度だけ登録
  if (!axisSelect._axisInitialized) {
    axisSelect._axisInitialized = true;
    axisSelect.addEventListener("change", () => {
      if (!axisSelect.value) return;
      setStep3ActiveAxis(axisSelect.value);
      if (AppState.step3SecondaryAxisCode === axisSelect.value) {
        setStep3SecondaryAxis("");
      }
    });
    searchInput?.addEventListener("input", () => _renderAxisSelector());
  }

  // クロス軸 セレクター（ドロップダウン）
  if (el2) {
    const sec = AppState.step3SecondaryAxisCode;
    const secCandidates = candidates.filter(c => c !== currentCode);

    if (!el2._sec2Initialized) {
      el2._sec2Initialized = true;
      el2.innerHTML = `
        <div class="step3-axis-section-title" style="margin-top:10px">クロス軸（任意）</div>
        <select id="step3-secondary-axis-select" class="step3-axis-select" style="height:auto; min-height:unset; padding:5px 8px; font-size:.85rem;">
          <option value="">なし</option>
        </select>`;
      document.getElementById("step3-secondary-axis-select")?.addEventListener("change", e => {
        setStep3SecondaryAxis(e.target.value);
      });
    }

    const sel = document.getElementById("step3-secondary-axis-select");
    if (sel) {
      sel.innerHTML = `<option value="${!sec ? "" : ""}">なし</option>` +
        secCandidates.map(code => {
          const { text, badge } = _getAxisSelectorLabel(code);
          return `<option value="${_esc(code)}"${code === sec ? " selected" : ""}>${_esc(code)}　${_esc(text)}　[${_esc(badge)}]</option>`;
        }).join("");
      if (!sec) sel.value = "";
    }
  }

  // 複合コントロール（axis② 選択時のみ表示）
  if (compositeCtrl) {
    const isComposite = Boolean(AppState.step3SecondaryAxisCode);
    compositeCtrl.style.display = isComposite ? "" : "none";
    if (isComposite) _renderCompositeControls(compositeCtrl);
  }
}

function _renderCompositeControls(el) {
  const mode     = AppState.step3CompositeDisplayMode;
  const priority = AppState.step3ColorPriority;
  const minN     = AppState.step3MinSampleSize;

  const modes = [
    { id: "split",  label: "小分け（推奨）" },
    { id: "flat",   label: "フラット" },
    { id: "nested", label: "ネスト" },
  ];
  const priorities = [
    { id: "axis1", label: "軸①ベース" },
    { id: "axis2", label: "軸②ベース" },
    { id: "auto",  label: "自動" },
  ];

  el.innerHTML = `<div class="step3-composite-controls">
    <span style="font-size:.82rem; font-weight:600; color:var(--color-text-muted)">表示モード：</span>
    <div class="step3-composite-mode-btns">
      ${modes.map(m => `<button class="step3-composite-mode-btn${m.id === mode ? " active" : ""}" data-mode="${m.id}">${_esc(m.label)}</button>`).join("")}
    </div>
    <span style="font-size:.82rem; font-weight:600; color:var(--color-text-muted); margin-left:8px">色基準：</span>
    <select id="step3-color-priority-select" style="font-size:.82rem; padding:2px 6px; border:1px solid var(--color-border); border-radius:3px">
      ${priorities.map(p => `<option value="${p.id}"${p.id === priority ? " selected" : ""}>${_esc(p.label)}</option>`).join("")}
    </select>
    <span style="font-size:.82rem; font-weight:600; color:var(--color-text-muted); margin-left:8px">N：</span>
    <input type="number" id="step3-min-sample-input" value="${minN}" min="0"
           style="width:60px; font-size:.82rem; padding:2px 6px; border:1px solid var(--color-border); border-radius:3px; text-align:right">
    <span style="font-size:.82rem; color:var(--color-text-muted)">未満非表示</span>
  </div>`;

  el.querySelectorAll(".step3-composite-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      setStep3CompositeDisplayMode(btn.dataset.mode);
      _rerunIfComposite();
    });
  });

  const prioritySel = el.querySelector("#step3-color-priority-select");
  if (prioritySel) {
    prioritySel.addEventListener("change", () => {
      setStep3ColorPriority(prioritySel.value);
      _rerenderCompositeIfNeeded();
    });
  }

  const minNInput = el.querySelector("#step3-min-sample-input");
  if (minNInput) {
    minNInput.addEventListener("change", () => {
      setStep3MinSampleSize(parseInt(minNInput.value, 10) || 0);
      _rerenderCompositeIfNeeded();
    });
  }
}

function _rerunIfComposite() {
  const currentData = _currentCacheKey ? _crosstabCache[_currentCacheKey] : _lastCrosstabData;
  if (currentData?.secondary_axis_question_code) {
    _runCrosstab();
  }
}

function _rerenderCompositeIfNeeded() {
  const currentData = _currentCacheKey ? _crosstabCache[_currentCacheKey] : _lastCrosstabData;
  if (!currentData?.secondary_axis_question_code) return;
  const container = document.getElementById("step3-results");
  if (container) _renderResults(container, currentData); // async だが完了を待つ必要はない
}

// ---------------------------------------------------------------------------
// サイドバー
// ---------------------------------------------------------------------------

function _initSidebar() {
  document.getElementById("step3-sidebar-collapse")?.addEventListener("click", () => {
    document.getElementById("step3-sidebar")?.classList.toggle("collapsed");
  });
  document.getElementById("step3-set-search")?.addEventListener("input", () => _renderSidebar());
}

function _renderViewPanel() {
  const el = document.getElementById("step3-view-panel");
  if (!el) return;
  const views = Object.values(AppState.step3Views ?? {});
  if (views.length < 2) { el.innerHTML = ""; return; }
  const activeId = AppState.step3ActiveViewId;
  const html = views.map(v => {
    const axis1Label = _getAxisLabel(v.axisCode);
    const axis2Label = v.secAxisCode ? ` × ${_getAxisLabel(v.secAxisCode)}` : "";
    const name = `${axis1Label}${axis2Label}`;
    const isActive = v.viewId === activeId;
    return `<div class="step3-view-item${isActive ? " active" : ""}" data-viewid="${_esc(v.viewId)}" title="${_esc(name)}">${_esc(name)}</div>`;
  }).join("");
  el.innerHTML = `
    <div class="step3-view-panel-header step3-sidebar-label">集計ビュー</div>
    <div class="step3-view-list">${html}</div>`;
  el.querySelectorAll(".step3-view-item").forEach(item => {
    item.addEventListener("click", () => setStep3ActiveViewId(item.dataset.viewid));
  });
}

function _renderSidebar() {
  const nav = document.getElementById("step3-sidebar-nav");
  if (!nav) return;

  const allSets   = AppState.questionSets;
  const searchVal = (document.getElementById("step3-set-search")?.value ?? "").trim().toLowerCase();

  if (!allSets.length) {
    nav.innerHTML = `<div class="step3-nav-empty">STEP1 で集計セットを設定してください</div>`;
    return;
  }

  const hasStep2 = Boolean(AppState.step2Filename);
  const canRun   = hasStep2;
  const activeId = AppState.step3ActiveSetId;

  // 分析対象 OFF の設問コードセット
  const excluded = new Set(AppState.excludedQuestionCodes);

  // 代表質問文取得用マップ（question_code → QuestionItem）
  const qMap = Object.fromEntries(AppState.questions.map(q => [q.question_code, q]));

  // フラットなセットリストを作成（isParent の場合は children を展開）
  // 分析対象 OFF の設問を除いた effectiveCodes が 0 件のセットはスキップ
  const flatSets = [];
  for (const s of allSets) {
    if (s.isParent && (s.children ?? []).length > 0) {
      for (const child of s.children) {
        if (child.isExcluded) continue;
        const eff = (child.questionCodes ?? []).filter(c => !excluded.has(c));
        if (eff.length > 0) flatSets.push({ ...child, _effectiveCodes: eff });
      }
    } else {
      if (s.isExcluded) continue;
      const eff = (s.questionCodes ?? []).filter(c => !excluded.has(c));
      if (eff.length > 0) flatSets.push({ ...s, _effectiveCodes: eff });
    }
  }

  let filtered = flatSets;
  if (searchVal) {
    filtered = flatSets.filter(s => s.setName.toLowerCase().includes(searchVal));
  }

  if (filtered.length === 0) {
    nav.innerHTML = `<div class="step3-nav-empty">STEP1 で集計セットを設定してください</div>`;
    return;
  }

  const itemHtml = (s) => {
    const effectiveCodes = s._effectiveCodes;
    const isActive    = s.setId === activeId;
    const isGenerated = Object.keys(_crosstabCache).some(k => k.endsWith(`||${s.setId}`));
    const disabledCls = canRun ? "" : " step3-nav-item-disabled";

    // 代表質問文: 最初の設問の parent_text → question_text の順で取得
    const firstQ   = qMap[effectiveCodes[0]];
    const descText = firstQ?.parent_text || firstQ?.question_text || "";

    return `<div class="step3-nav-item${isActive ? " active" : ""}${disabledCls}"
              data-setid="${_esc(s.setId)}" title="${_esc(s.setName)}">
      ${isGenerated
        ? `<span class="step3-nav-dot"></span>`
        : `<span class="step3-nav-dot-placeholder"></span>`}
      <div class="step3-nav-item-body">
        <div class="step3-nav-item-header">
          <span class="step3-nav-item-name step3-sidebar-label">${_esc(s.setName)}</span>
          <span class="step3-nav-item-count step3-sidebar-label">(${effectiveCodes.length})</span>
        </div>
        ${descText ? `<div class="step3-nav-item-desc step3-sidebar-label">${_esc(descText)}</div>` : ""}
      </div>
    </div>`;
  };

  let html = filtered.map(itemHtml).join("");

  if (!canRun) {
    html += `<div class="step3-nav-note">STEP2 でデータを読み込んでください</div>`;
  }

  nav.innerHTML = html;

  nav.querySelectorAll(".step3-nav-item:not(.step3-nav-item-disabled)").forEach(item => {
    item.addEventListener("click", () => {
      const setId = item.dataset.setid;
      const set = AppState.questionSets.find(s => s.setId === setId)
        || (() => { for (const p of AppState.questionSets) { const c = (p.children??[]).find(c=>c.setId===setId); if(c) return c; } })();
      const excluded = new Set(AppState.excludedQuestionCodes);
      const codes = (set?.questionCodes ?? []).filter(c => !excluded.has(c));
      setStep3ActiveSetId(setId);
      setStep3SelectedQuestionCodes(codes);
    });
  });
}

// ---------------------------------------------------------------------------
// レポート追加 重複確認モーダル
// ---------------------------------------------------------------------------

function _showDuplicateModal(cr, s3, existingPage) {
  const modal = document.getElementById("step3-duplicate-modal");
  const titleEl = document.getElementById("step3-dup-page-title");
  if (!modal) return;
  if (titleEl) {
    titleEl.textContent = existingPage.aggregationConfig?.questionCode
      ? existingPage.aggregationConfig.questionCode + " の集計"
      : cr.title ?? "この集計";
  }
  const overwriteBtn = document.getElementById("step3-dup-overwrite-btn");
  const addBtn       = document.getElementById("step3-dup-add-btn");
  const cancelBtn    = document.getElementById("step3-dup-cancel-btn");
  const close = () => { modal.style.display = "none"; };
  overwriteBtn?.addEventListener("click", () => {
    close();
    overwriteReportPageFromStep3(existingPage.id ?? existingPage.pageId, cr, s3);
    setActivePanel("report");
    showToast("レポートページを上書き更新しました。");
  }, { once: true });
  addBtn?.addEventListener("click", () => {
    close();
    addReportPageFromStep3(cr, s3);
    setActivePanel("report");
    showToast("新しいページとして追加しました。");
  }, { once: true });
  cancelBtn?.addEventListener("click", close, { once: true });
  modal.style.display = "";
}

// ---------------------------------------------------------------------------
// クロス集計実行
// ---------------------------------------------------------------------------

// 二次軸あり API レスポンスを STEP4 の comparison_datasets 形式に変換
function _buildComparisonDatasets(result, data) {
  const primaryCats = data.primary_axis_categories ?? [];
  const sep = " × ";
  return primaryCats.map(primaryCat => {
    const prefix = primaryCat + sep;
    const indices = (data.axis_categories ?? [])
      .map((cat, i) => ({ cat, i }))
      .filter(({ cat }) => cat.startsWith(prefix))
      .map(({ i }) => i);
    const secCats   = indices.map(i => data.axis_categories[i].slice(prefix.length));
    const secTotals = indices.map(i => (data.axis_totals ?? [])[i] ?? 0);
    const filteredRows = (result.rows ?? []).map(row => ({
      ...row,
      percents: indices.map(i => (row.percents ?? [])[i] ?? 0),
      counts:   indices.map(i => (row.counts   ?? [])[i] ?? 0),
    }));
    return { target_value: primaryCat, rows: filteredRows, axis_categories: secCats, axis_totals: secTotals };
  });
}

// モードに応じてパラメータを解決してクロス集計を実行する
async function _runStep3() {
  const mode = AppState.step3Mode || "brand_comparison";
  const sessionToken = AppState.sessionToken;
  if (!sessionToken) { showToast("セッションが切れています。ページを再読み込みしてください。"); return; }

  const selectedCodes = AppState.step3SelectedQuestionCodes;
  if (!selectedCodes.length) { showToast("集計対象設問を1つ以上選択してください"); return; }

  let axisCode, secAxisCode, filterColumn, filterValues;

  if (mode === "brand_comparison") {
    axisCode = AppState.step3BasicAxisCode;
    secAxisCode = AppState.step3ComparisonAxisCode || "";
    filterColumn = AppState.step3TargetFilterColumn;
    filterValues = AppState.step3TargetFilterValues;
    if (!axisCode) { showToast("基本軸を選択してください"); return; }

  } else if (mode === "deep_dive") {
    axisCode = AppState.step3ComparisonAxisCode;
    secAxisCode = "";
    filterColumn = AppState.step3BasicAxisCode;
    filterValues = AppState.step3DeepDiveTarget ? [AppState.step3DeepDiveTarget] : [];
    if (!axisCode) { showToast("比較軸を選択してください"); return; }
    if (!filterColumn || !filterValues.length) { showToast("基本軸と対象を選択してください"); return; }

    // dive専用の追加フィルタは現在未実装（拡張余地あり）

  } else { // question_comparison
    axisCode = AppState.step3BasicAxisCode || "";
    secAxisCode = "";
    filterColumn = "";
    filterValues = [];
    if (!axisCode) { showToast("集計軸を選択してください（または「なし」のままで全体集計）"); }
  }

  // 旧stateを同期（キャッシュキーと ChartResult 生成のため）
  AppState.step3ActiveAxisCode = axisCode;
  AppState.step3SecondaryAxisCode = secAxisCode;
  AppState.step3TargetFilterColumn = filterColumn;
  AppState.step3TargetFilterValues = Array.isArray(filterValues) ? filterValues : [];

  await _runCrosstab(null, selectedCodes);
  // deep_dive: step3ActiveViewId は "basicAxis||compAxis" のままなので
  // スワップした axisCode を元に戻して一貫性を保つ
  if (mode === "deep_dive") {
    AppState.step3ActiveAxisCode = AppState.step3BasicAxisCode;
    AppState.step3SecondaryAxisCode = AppState.step3ComparisonAxisCode;
  }
}

async function _runCrosstab(setId, overrideCodes) {
  const activeSetId = setId || AppState.step3ActiveSetId;
  const axisCode = AppState.step3ActiveAxisCode;
  if (!axisCode || !AppState.sessionToken) return;

  const secAxisCode = AppState.step3SecondaryAxisCode;
  let targetCodes;
  if (overrideCodes) {
    targetCodes = overrideCodes;
  } else {
    // フラット一覧で検索、なければ children を探索（カスタム親セットの子）
    let set = AppState.questionSets.find(s => s.setId === activeSetId);
    if (!set) {
      for (const parent of AppState.questionSets) {
        const child = (parent.children ?? []).find(c => c.setId === activeSetId);
        if (child) { set = child; break; }
      }
    }
    const _excl = new Set(AppState.excludedQuestionCodes);
    targetCodes = (set?.questionCodes ?? []).filter(c => !_excl.has(c));
  }
  if (!targetCodes.length) { showToast("集計対象設問がありません"); return; }
  const key = _getCacheKey(axisCode, secAxisCode, activeSetId || targetCodes.join(","));

  const progressEl  = document.getElementById("step3-progress");
  const progressMsg = document.getElementById("step3-progress-msg");
  const resultsEl   = document.getElementById("step3-results");
  const placeholder = document.getElementById("step3-placeholder");
  if (!resultsEl) return;

  // キャッシュヒット → 即時表示
  if (_crosstabCache[key]) {
    _currentCacheKey = key;
    _destroyAllCharts();
    _clearPendingChartRenders();
    if (placeholder) placeholder.style.display = "none";
    await _renderResults(resultsEl, _crosstabCache[key]);
    _renderSidebar();
    return;
  }

  // キャッシュミス → API 呼び出し
  if (progressEl) progressEl.style.display = "";
  if (progressMsg) progressMsg.textContent = `⏳ 集計中… (${targetCodes.length || "全"}問)`;
  _destroyAllCharts();
  _clearPendingChartRenders();

  try {
    const data = await generateCrosstab(
      AppState.sessionToken, axisCode, secAxisCode, targetCodes,
      AppState.step3TargetFilterColumn, AppState.step3TargetFilterValues
    );
    _crosstabCache[key] = data;
    _currentCacheKey = key;
    AppState.step3LastGeneratedAxisCode = axisCode;
    _lastCrosstabData = data;
    // ChartResult として自動保存（STEP4 が参照する）— 比較軸あり時も生成
    {
      const col = AppState.step3TargetFilterColumn;
      const vals = AppState.step3TargetFilterValues;
      const filterKey = col ? `${col}:${[...vals].sort().join(",")}` : "";
      const newChartResults = (data.results ?? []).map(result => ({
        id: `${result.question_code}||${axisCode}||${filterKey}`,
        title: `${result.question_text} × ${data.axis_question_text ?? axisCode}`,
        mode: "comparison",
        question_code: result.question_code,
        question_text: result.question_text,
        type_code: result.type_code,
        axis_code: axisCode,
        axis_label: data.axis_question_text ?? axisCode,
        axis_categories: data.axis_categories,
        axis_totals: data.axis_totals,
        rows: result.rows,
        secondary_axis_code:  data.secondary_axis_question_code  || undefined,
        secondary_axis_label: data.secondary_axis_question_text || undefined,
        comparison_datasets: data.secondary_axis_question_code
          ? _buildComparisonDatasets(result, data)
          : undefined,
        target_filter_column: col,
        target_filter_values: [...vals],
        created_at: new Date().toISOString(),
      }));
      addChartResults(newChartResults);
    }
    if (placeholder) placeholder.style.display = "none";
    await _renderResults(resultsEl, data);
    _renderSidebar();
  } catch (err) {
    if (placeholder) placeholder.style.display = "none";
    resultsEl.innerHTML = `<div class="card"><div class="card-body" style="color:var(--color-danger,#e53e3e)">エラー: ${_esc(err.message)}</div></div>`;
  } finally {
    if (progressEl) progressEl.style.display = "none";
    _renderSidebar();
  }
}

// ---------------------------------------------------------------------------
// 結果描画
// ---------------------------------------------------------------------------

async function _renderResults(container, data) {
  if (data.secondary_axis_question_code) {
    await _renderCompositeResults(container, data);
  } else {
    await _renderSimpleResults(container, data);
  }
}

function _updateAxisNcount(axisLabel, categories, totals, warningsHtml) {
  const el = document.getElementById("step3-axis-ncount");
  if (!el) return;
  const cats = categories.map((cat, i) =>
    `<span style="white-space:nowrap">${_esc(cat)} <span style="color:var(--color-text-muted)">n=${totals[i] ?? 0}</span></span>`
  ).join("");
  el.innerHTML = `
    <div style="font-size:.85rem; font-weight:600; margin-bottom:4px">${_esc(axisLabel)}</div>
    <div style="display:flex; flex-wrap:wrap; gap:6px 16px; font-size:.85rem">${cats}</div>
    ${warningsHtml ? `<div style="margin-top:6px; color:var(--color-warning,#c05621); font-size:.8rem">${warningsHtml}</div>` : ""}
  `;
  el.style.display = "block";
}

async function _renderSimpleResults(container, data) {
  const { axis_question_text, axis_categories, axis_totals, results, warnings } = data;
  const axisCode = AppState.step3LastGeneratedAxisCode || AppState.step3ActiveAxisCode;
  const _filterCol = AppState.step3TargetFilterColumn;
  const _filterVals = AppState.step3TargetFilterValues;
  const filterKey = _filterCol ? `${_filterCol}:${[..._filterVals].sort().join(",")}` : "";

  // ヘッダー（一括変更バー + 一括エクスポートバー）を先に挿入してUIを即時表示
  container.innerHTML =
    _buildBulkBar() +
    `<div class="card" style="margin-bottom:8px">
      <div class="card-body" style="padding:10px 16px; display:flex; align-items:center; flex-wrap:wrap; gap:8px">
        <span style="font-size:.85rem; font-weight:600; color:var(--color-text-muted)">一括出力：</span>
        <button id="step3-export-all-excel" class="btn btn-secondary btn-sm">📥 すべてExcel</button>
        <button id="step3-export-all-csv"   class="btn btn-secondary btn-sm">📥 すべてCSV (ZIP)</button>
        <button id="step3-export-all-png"   class="btn btn-secondary btn-sm">📥 すべてPNG</button>
      </div>
    </div>`;

  // 設問カードを10枚ごとにチャンク挿入してメインスレッドを解放する
  const CHUNK = 10;
  for (let idx = 0; idx < results.length; idx++) {
    const result = results[idx];
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

    const cardHtml = `
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
          <button class="btn step3-add-report-btn"
                  data-cr-id="${_esc(`${result.question_code}||${axisCode}||${filterKey}`)}"
                  style="background:var(--color-primary,#3B82F6);color:#fff;font-weight:700;padding:5px 22px;font-size:.9rem;letter-spacing:.03em;box-shadow:0 2px 6px rgba(59,130,246,.35)"
                  title="この設問をレポートに追加">＋ レポートに追加</button>
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
          <label class="step3-pct-label-wrap">
            <input type="checkbox" class="step3-total-col-cb"
                   data-q="${_esc(result.question_code)}" data-idx="${idx}"
                   ${settings.showTotalCol ? "checked" : ""}> 合計列
          </label>
          ${_buildAggModeHtml(idx, result.question_code, settings.chartType, settings.aggMode)}
          <span class="step3-height-ctrl" style="display:flex; align-items:center; gap:4px; font-size:.82rem">
            <span style="color:var(--color-text-muted)">高さ：</span>
            <input type="range" class="step3-chart-height-slider"
                   data-q="${_esc(result.question_code)}" data-idx="${idx}"
                   min="150" max="540" step="10"
                   value="${settings.chartHeight ?? 270}"
                   style="width:80px; accent-color:var(--color-primary,#3B82F6)">
            <span class="step3-chart-height-val" style="min-width:30px">${settings.chartHeight ? settings.chartHeight + "px" : "自動"}</span>
            <button class="btn btn-secondary btn-sm step3-chart-height-reset-btn"
                    data-q="${_esc(result.question_code)}" data-idx="${idx}">自動</button>
          </span>
          <span class="step3-bar-width-ctrl" style="display:${BAR_WIDTH_TYPES.has(settings.chartType) ? "flex" : "none"}; align-items:center; gap:4px; font-size:.82rem">
            <span style="color:var(--color-text-muted)">棒の太さ：</span>
            <input type="range" class="step3-bar-width-slider"
                   data-q="${_esc(result.question_code)}" data-idx="${idx}"
                   min="10" max="100" step="5"
                   value="${Math.round((settings.barWidth ?? 0.9) * 100)}"
                   style="width:70px; accent-color:var(--color-primary,#3B82F6)">
            <span class="step3-bar-width-val" style="min-width:30px">${Math.round((settings.barWidth ?? 0.9) * 100)}%</span>
          </span>
          <span class="step3-split-ctrl" style="display:flex; align-items:center; gap:3px; font-size:.78rem; border-left:1px solid var(--color-border,#e5e7eb); margin-left:4px; padding-left:8px">
            <span style="color:var(--color-text-muted)">分割：</span>
            <button class="step3-split-btn btn btn-secondary btn-sm${settings.splitMode === "normal" ? " active" : ""}" data-q="${_esc(result.question_code)}" data-idx="${idx}" data-split="normal" style="padding:1px 6px; font-size:.78rem">通常</button>
            <button class="step3-split-btn btn btn-secondary btn-sm${settings.splitMode === "by_axis" ? " active" : ""}" data-q="${_esc(result.question_code)}" data-idx="${idx}" data-split="by_axis" style="padding:1px 6px; font-size:.78rem">基本軸</button>
            <button class="step3-split-btn btn btn-secondary btn-sm${settings.splitMode === "by_comparison" ? " active" : ""}" data-q="${_esc(result.question_code)}" data-idx="${idx}" data-split="by_comparison" style="padding:1px 6px; font-size:.78rem">比較軸</button>
          </span>
          <span class="step3-split-cols-ctrl" style="display:${settings.splitMode !== "normal" ? "flex" : "none"}; align-items:center; gap:4px; font-size:.78rem">
            <span style="color:var(--color-text-muted)">列：</span>
            <select class="step3-split-cols-select" data-q="${_esc(result.question_code)}" data-idx="${idx}" style="font-size:.78rem; padding:1px 4px">
              <option value="">自動</option>
              <option value="1"${settings.splitColumns === 1 ? " selected" : ""}>1列</option>
              <option value="2"${settings.splitColumns === 2 ? " selected" : ""}>2列</option>
              <option value="3"${settings.splitColumns === 3 ? " selected" : ""}>3列</option>
            </select>
          </span>
          <span class="step3-split-ipp-ctrl" style="display:${settings.splitMode !== "normal" ? "flex" : "none"}; align-items:center; gap:4px; font-size:.78rem; border-left:1px solid var(--color-border,#e5e7eb); margin-left:4px; padding-left:8px">
            <span style="color:var(--color-text-muted)">件/P：</span>
            <select class="step3-split-ipp-select" data-q="${_esc(result.question_code)}" data-idx="${idx}" style="font-size:.78rem; padding:1px 4px">
              <option value="">自動</option>
              <option value="1"${settings.itemsPerPage === 1 ? " selected" : ""}>1</option>
              <option value="2"${settings.itemsPerPage === 2 ? " selected" : ""}>2</option>
              <option value="3"${settings.itemsPerPage === 3 ? " selected" : ""}>3</option>
              <option value="4"${settings.itemsPerPage === 4 ? " selected" : ""}>4</option>
              <option value="6"${settings.itemsPerPage === 6 ? " selected" : ""}>6</option>
            </select>
          </span>
          <span class="step3-split-layout-ctrl" style="display:${settings.splitMode !== "normal" ? "flex" : "none"}; align-items:center; gap:4px; font-size:.78rem">
            <span style="color:var(--color-text-muted)">配置：</span>
            <select class="step3-split-layout-select" data-q="${_esc(result.question_code)}" data-idx="${idx}" style="font-size:.78rem; padding:1px 4px">
              <option value="auto"${!settings.pageLayout || settings.pageLayout === "auto" ? " selected" : ""}>自動</option>
              <option value="vertical"${settings.pageLayout === "vertical" ? " selected" : ""}>縦並び</option>
              <option value="horizontal"${settings.pageLayout === "horizontal" ? " selected" : ""}>横並び</option>
              <option value="cols2"${settings.pageLayout === "cols2" ? " selected" : ""}>2列</option>
              <option value="cols3"${settings.pageLayout === "cols3" ? " selected" : ""}>3列</option>
            </select>
          </span>
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

    container.insertAdjacentHTML("beforeend", cardHtml);
    // CHUNK 枚ごとにメインスレッドへ制御を返す
    if (idx % CHUNK === CHUNK - 1) await yieldToMain();
  }

  if (!results.length) {
    container.insertAdjacentHTML("beforeend",
      `<div class="card"><div class="card-body" style="color:var(--color-text-muted); text-align:center; padding:32px">
        クロス集計できる設問がありませんでした。
      </div></div>`);
  }

  // 軸N数をシンプル表示
  const warningsHtml = warnings.length
    ? warnings.map(w => _esc(w)).join("<br>")
    : "";
  _updateAxisNcount(axis_question_text, axis_categories, axis_totals, warningsHtml);

  // 各設問のグラフを遅延描画（折りたたまれていないもののみ）
  const isCompositeSimple = Boolean(data.secondary_axis_question_code);
  results.forEach((result, idx) => {
    const settings = _getSettings(result.question_code, result.type_code);
    if (settings.collapsed) return;
    const areaEl = document.getElementById(`step3-chart-area-${idx}`);
    if (!areaEl) return;
    _scheduleChartRender(areaEl, () => {
      if (isCompositeSimple) _applyCompositeColorLookup(axis_categories);
      if (settings.splitMode === "by_axis" || settings.splitMode === "by_comparison") {
        _renderSplitInArea(areaEl, result, settings, axis_categories, axis_totals, settings.splitMode);
      } else {
        _renderChartInArea(areaEl, result, settings, axis_categories, axis_totals);
      }
      _compositeColorPaletteLookup = null;
    });
  });

  // 一括エクスポートボタンにイベントを登録
  initStep3ExportBulkButtons();
}

// ---------------------------------------------------------------------------
// 複合集計結果描画
// ---------------------------------------------------------------------------

async function _renderCompositeResults(container, data) {
  const minN = AppState.step3MinSampleSize;

  // N数フィルター
  const keepIndices = data.axis_totals
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n >= minN)
    .map(({ i }) => i);

  const filteredCats   = keepIndices.map(i => data.axis_categories[i]);
  const filteredTotals = keepIndices.map(i => data.axis_totals[i]);
  const filteredResults = data.results.map(result => ({
    ...result,
    rows: result.rows.map(row => ({
      ...row,
      counts:   keepIndices.map(i => row.counts[i]),
      percents: keepIndices.map(i => row.percents[i]),
    })),
  }));

  const filteredData = {
    ...data,
    axis_categories: filteredCats,
    axis_totals: filteredTotals,
    results: filteredResults,
  };

  const mode = AppState.step3CompositeDisplayMode;
  if (mode === "split") {
    await _renderSplitResults(container, filteredData);
  } else {
    await _renderSimpleResults(container, filteredData);
  }
}

const _COMPOSITE_SEP = " × ";

async function _renderSplitResults(container, data) {
  const {
    axis_question_text, axis_categories, axis_totals,
    primary_axis_categories, secondary_axis_categories, results, warnings,
  } = data;

  // 複合カテゴリーを primary ごとにグループ化
  const groupData = primary_axis_categories
    .map(primaryCat => {
      const prefix = primaryCat + _COMPOSITE_SEP;
      const indices = axis_categories
        .map((cat, i) => ({ cat, i }))
        .filter(({ cat }) => cat.startsWith(prefix))
        .map(({ i }) => i);
      if (!indices.length) return null;
      const groupCats   = indices.map(i => axis_categories[i].slice(prefix.length));
      const groupTotals = indices.map(i => axis_totals[i]);
      return { primaryCat, indices, groupCats, groupTotals };
    })
    .filter(Boolean);

  if (!groupData.length) {
    container.innerHTML = `<div class="card"><div class="card-body" style="color:var(--color-text-muted); text-align:center; padding:32px">
      N数フィルターにより全データが除外されました。N未満非表示の閾値を下げてください。
    </div></div>`;
    return;
  }

  // ヘッダー先行挿入
  container.innerHTML =
    _buildBulkBar() +
    `<div class="card" style="margin-bottom:8px">
      <div class="card-body" style="padding:10px 16px; display:flex; align-items:center; flex-wrap:wrap; gap:8px">
        <span style="font-size:.85rem; font-weight:600; color:var(--color-text-muted)">一括出力：</span>
        <button id="step3-export-all-excel" class="btn btn-secondary btn-sm">📥 すべてExcel</button>
        <button id="step3-export-all-csv"   class="btn btn-secondary btn-sm">📥 すべてCSV (ZIP)</button>
        <button id="step3-export-all-png"   class="btn btn-secondary btn-sm">📥 すべてPNG</button>
      </div>
    </div>`;

  // 設問ごとのカードをチャンク挿入
  const CHUNK = 10;
  for (let idx = 0; idx < results.length; idx++) {
    const result = results[idx];
    const settings = _getSettings(result.question_code, result.type_code);
    const recommended     = _recommendedType(result.type_code);
    const recommendedLabel = _recommendedLabel(result.type_code);

    const chartBtnGroup = `<div class="step3-chart-type-btns">${
      CHART_TYPES.map(t => {
        const suit  = _chartSuitability(t.id, result.type_code);
        const active = t.id === settings.chartType ? " active" : "";
        const cls   = suit === "not_recommended" ? " not-recommended" : "";
        const title = suit === "not_recommended" ? `${t.label}（非推奨）` : t.label;
        return `<button class="step3-chart-btn${active}${cls}" data-q="${_esc(result.question_code)}" data-idx="${idx}" data-chart="${t.id}" title="${_esc(title)}">${_esc(t.label)}</button>`;
      }).join("")
    }</div>`;

    const showOrient = ORIENTATION_TYPES.has(settings.chartType);
    const orientHtml = showOrient ? `
      <span class="step3-orient-ctrl">
        向き：
        <label style="font-size:.82rem; cursor:pointer"><input type="radio" class="step3-orient-radio" name="step3-orient-${idx}" value="v" data-q="${_esc(result.question_code)}" data-idx="${idx}" ${settings.orientation === "v" ? "checked" : ""}> 縦</label>
        <label style="font-size:.82rem; cursor:pointer"><input type="radio" class="step3-orient-radio" name="step3-orient-${idx}" value="h" data-q="${_esc(result.question_code)}" data-idx="${idx}" ${settings.orientation === "h" ? "checked" : ""}> 横</label>
      </span>` : "";
    const transposeHtml = showOrient ? `
      <span class="step3-transpose-ctrl">
        表示方向：
        <label style="font-size:.82rem; cursor:pointer"><input type="radio" class="step3-transpose-radio" name="step3-transpose-${idx}" value="false" data-q="${_esc(result.question_code)}" data-idx="${idx}" ${!settings.transpose ? "checked" : ""}> 通常</label>
        <label style="font-size:.82rem; cursor:pointer"><input type="radio" class="step3-transpose-radio" name="step3-transpose-${idx}" value="true"  data-q="${_esc(result.question_code)}" data-idx="${idx}" ${settings.transpose ? "checked" : ""}> 行列入替</label>
      </span>` : "";

    const excludedBadge = `<span id="step3-excluded-badge-${idx}" class="badge-excluded"${settings.excluded ? "" : " hidden"}>除外</span>`;

    // split グループ内の各グラフエリアを生成
    const splitGroupsHtml = groupData.map((g, gIdx) => `
      <div class="step3-split-group">
        <div class="step3-split-group-title">${_esc(g.primaryCat)}</div>
        <div class="step3-split-n-row">
          ${g.groupCats.map((cat, ci) => `<span>n=${g.groupTotals[ci]}</span>`).join(" ")}
        </div>
        <div id="step3-chart-area-${idx}-${gIdx}" class="step3-chart-area" style="margin-bottom:4px"></div>
      </div>`).join("");

    const cardHtml = `
    <div id="step3-card-${idx}" class="card${settings.excluded ? " step3-excluded-card" : ""}" style="margin-bottom:8px">
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
          <button class="btn btn-secondary btn-sm step3-exclude-btn" data-q="${_esc(result.question_code)}" data-idx="${idx}" data-excluded="${settings.excluded}">
            ${settings.excluded ? "出力対象に戻す" : "除外する"}
          </button>
          <button class="btn btn-secondary btn-sm step3-collapse-btn" data-q="${_esc(result.question_code)}" data-idx="${idx}">
            ${settings.collapsed ? "展開 ▼" : "折りたたむ ▲"}
          </button>
          <button class="btn btn-secondary btn-sm step3-export-excel-btn" data-idx="${idx}" title="Excelとして保存">📊 Excel</button>
          <button class="btn btn-secondary btn-sm step3-export-csv-btn"   data-idx="${idx}" title="CSVとして保存">📄 CSV</button>
          <button class="btn btn-secondary btn-sm step3-export-png-btn"   data-idx="${idx}" title="PNGとして保存">🖼 PNG</button>
        </div>
      </div>
      <div id="step3-body-${idx}"${settings.collapsed ? " hidden" : ""}>
        <div class="step3-controls-bar">
          <span style="font-size:.78rem; color:var(--color-text-muted)">推奨: ${_esc(recommendedLabel)}</span>
          ${chartBtnGroup}
          <button class="btn btn-secondary btn-sm step3-chart-reset-btn" data-q="${_esc(result.question_code)}" data-type="${_esc(recommended)}" data-idx="${idx}">推奨に戻す</button>
          ${orientHtml}
          <label class="step3-pct-label-wrap">
            <input type="checkbox" class="step3-pct-label-cb" data-q="${_esc(result.question_code)}" data-idx="${idx}" ${settings.showPctLabel ? "checked" : ""}> ％ラベル
          </label>
          <span style="font-size:.82rem; color:var(--color-text-muted)">ソート：</span>
          <select class="step3-sort-select" data-q="${_esc(result.question_code)}" data-idx="${idx}">
            <option value="original"${settings.sortOrder === "original" ? " selected" : ""}>元の順番</option>
            <option value="desc"${settings.sortOrder === "desc" ? " selected" : ""}>降順</option>
            <option value="asc"${settings.sortOrder === "asc" ? " selected" : ""}>昇順</option>
          </select>
          ${transposeHtml}
          <label class="step3-pct-label-wrap">
            <input type="checkbox" class="step3-total-col-cb"
                   data-q="${_esc(result.question_code)}" data-idx="${idx}"
                   ${settings.showTotalCol ? "checked" : ""}> 合計列
          </label>
          ${_buildAggModeHtml(idx, result.question_code, settings.chartType, settings.aggMode)}
        </div>
        <div class="card-body" style="padding:16px">
          ${splitGroupsHtml}
        </div>
      </div>
    </div>`;

    container.insertAdjacentHTML("beforeend", cardHtml);
    if (idx % CHUNK === CHUNK - 1) await yieldToMain();
  }

  if (!results.length) {
    container.insertAdjacentHTML("beforeend",
      `<div class="card"><div class="card-body" style="color:var(--color-text-muted); text-align:center; padding:32px">
        クロス集計できる設問がありませんでした。
      </div></div>`);
  }

  // 軸N数をシンプル表示（split: primary軸ごとに合計n数）
  {
    const splitCats   = groupData.map(g => g.primaryCat);
    const splitTotals = groupData.map(g => g.groupTotals.reduce((s, n) => s + n, 0));
    const warningsHtml = warnings?.length ? warnings.map(w => _esc(w)).join("<br>") : "";
    _updateAxisNcount(axis_question_text, splitCats, splitTotals, warningsHtml);
  }

  // split グループごとにグラフを遅延描画
  const colorPriority = AppState.step3ColorPriority;
  results.forEach((result, idx) => {
    const settings = _getSettings(result.question_code, result.type_code);
    if (settings.collapsed) return;
    groupData.forEach((g, gIdx) => {
      const areaEl = document.getElementById(`step3-chart-area-${idx}-${gIdx}`);
      if (!areaEl) return;

      _scheduleChartRender(areaEl, () => {
        const groupResult = {
          ...result,
          rows: result.rows.map(row => ({
            ...row,
            counts:   g.indices.map(i => row.counts[i]),
            percents: g.indices.map(i => row.percents[i]),
          })),
        };
        if (colorPriority === "axis1") {
          _compositeColorPaletteLookup = g.groupCats;
        } else if (colorPriority === "axis2") {
          _compositeColorPaletteLookup = g.groupCats.map(() => g.primaryCat);
        } else {
          _compositeColorPaletteLookup = null;
        }
        _renderChartInArea(areaEl, groupResult, settings, g.groupCats, g.groupTotals);
        _compositeColorPaletteLookup = null;
      });
    });
  });

  initStep3ExportBulkButtons();
}

// ---------------------------------------------------------------------------
// イベント委譲ハンドラ
// ---------------------------------------------------------------------------

function _onResultsInput(e) {
  // グラフ高さスライダー：ライブプレビュー
  const heightSlider = e.target.closest(".step3-chart-height-slider");
  if (heightSlider) {
    const val = parseInt(heightSlider.value, 10);
    const ctrl = heightSlider.closest(".step3-height-ctrl");
    if (ctrl) {
      const valEl = ctrl.querySelector(".step3-chart-height-val");
      if (valEl) valEl.textContent = val + "px";
    }
    const idx = parseInt(heightSlider.dataset.idx, 10);
    const areaEl = document.getElementById(`step3-chart-area-${idx}`);
    if (areaEl) {
      areaEl.style.height = val + "px";
      const chart = _charts.get(areaEl.id);
      if (chart && !Array.isArray(chart)) chart.resize();
    }
    return;
  }

  // 棒の太さスライダー：ラベルのみ更新（再描画は change で）
  const barWidthSlider = e.target.closest(".step3-bar-width-slider");
  if (barWidthSlider) {
    const val = parseInt(barWidthSlider.value, 10);
    const ctrl = barWidthSlider.closest(".step3-bar-width-ctrl");
    if (ctrl) {
      const valEl = ctrl.querySelector(".step3-bar-width-val");
      if (valEl) valEl.textContent = val + "%";
    }
    return;
  }

  // 一括棒の太さスライダー：ラベル更新
  if (e.target.id === "step3-bulk-bar-width") {
    const valEl = document.getElementById("step3-bulk-bar-width-val");
    if (valEl) valEl.textContent = e.target.value + "%";
    return;
  }
}

function _onResultsChange(e) {
  // 軸ラジオ（STEP3 軸セレクターと被らないよう step3-orient-radio でフィルタ）
  const orientRadio = e.target.closest(".step3-orient-radio");
  if (orientRadio?.checked) {
    setStep3Setting(orientRadio.dataset.q, "orientation", orientRadio.value);
    _rerenderQuestionFull(parseInt(orientRadio.dataset.idx, 10));
    return;
  }

  // 行列入替ラジオ
  const transposeRadio = e.target.closest(".step3-transpose-radio");
  if (transposeRadio?.checked) {
    setStep3Setting(transposeRadio.dataset.q, "transpose", transposeRadio.value === "true");
    _rerenderQuestionFull(parseInt(transposeRadio.dataset.idx, 10));
    return;
  }

  // 集計方法ラジオ
  const aggRadio = e.target.closest(".step3-agg-radio");
  if (aggRadio?.checked) {
    setStep3Setting(aggRadio.dataset.q, "aggMode", aggRadio.value);
    _rerenderQuestionFull(parseInt(aggRadio.dataset.idx, 10));
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

  // グラフ高さスライダー（change: 状態保存）
  const heightSlider = e.target.closest(".step3-chart-height-slider");
  if (heightSlider) {
    const val = parseInt(heightSlider.value, 10);
    setStep3Setting(heightSlider.dataset.q, "chartHeight", val);
    return;
  }

  // 棒の太さスライダー（change: 状態保存 + 再描画）
  const barWidthSlider = e.target.closest(".step3-bar-width-slider");
  if (barWidthSlider) {
    const val = parseInt(barWidthSlider.value, 10) / 100;
    setStep3Setting(barWidthSlider.dataset.q, "barWidth", val);
    _rerenderQuestionFull(parseInt(barWidthSlider.dataset.idx, 10));
    return;
  }

  // 分割列セレクト
  const splitColsSel = e.target.closest(".step3-split-cols-select");
  if (splitColsSel) {
    const v = splitColsSel.value;
    setStep3Setting(splitColsSel.dataset.q, "splitColumns", v ? parseInt(v, 10) : null);
    _rerenderQuestion(parseInt(splitColsSel.dataset.idx, 10));
    return;
  }

  // 分割: 件/ページ セレクト
  const ippSel = e.target.closest(".step3-split-ipp-select");
  if (ippSel) {
    const v = ippSel.value;
    setStep3Setting(ippSel.dataset.q, "itemsPerPage", v ? parseInt(v, 10) : null);
    return;
  }

  // 分割: 配置形式 セレクト
  const layoutSel = e.target.closest(".step3-split-layout-select");
  if (layoutSel) {
    setStep3Setting(layoutSel.dataset.q, "pageLayout", layoutSel.value || "auto");
    return;
  }
}

function _onResultsClick(e) {
  // 分割モードボタン
  const splitBtn = e.target.closest(".step3-split-btn");
  if (splitBtn) {
    const q   = splitBtn.dataset.q;
    const idx = parseInt(splitBtn.dataset.idx, 10);
    const mode = splitBtn.dataset.split;
    setStep3Setting(q, "splitMode", mode);
    // ボタンのアクティブ状態を更新
    splitBtn.closest(".step3-split-ctrl")
      .querySelectorAll(".step3-split-btn")
      .forEach(b => b.classList.toggle("active", b.dataset.split === mode));
    // 列選択・件/P・配置 の表示切替
    const bar = splitBtn.closest(".step3-controls-bar");
    if (bar) {
      const visible = mode !== "normal" ? "flex" : "none";
      [".step3-split-cols-ctrl", ".step3-split-ipp-ctrl", ".step3-split-layout-ctrl"].forEach(sel => {
        const el = bar.querySelector(sel);
        if (el) el.style.display = visible;
      });
    }
    _rerenderQuestion(idx);
    return;
  }

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
    _toggleBarWidthCtrl(idx, chart);
    const curAggMode = _getSettings(qCode, "").aggMode ?? "col_pct";
    _updateAggRadios(idx, chart, curAggMode);
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
    _toggleBarWidthCtrl(idx, recommended);
    const curAggModeR = _getSettings(qCode, "").aggMode ?? "col_pct";
    _updateAggRadios(idx, recommended, curAggModeR);
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

  // 合計列 checkbox
  const totalColCb = e.target.closest(".step3-total-col-cb");
  if (totalColCb) {
    setStep3Setting(totalColCb.dataset.q, "showTotalCol", totalColCb.checked);
    _rerenderQuestionFull(parseInt(totalColCb.dataset.idx, 10));
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
      const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
      const result = d?.results[idx];
      const areaEl = document.getElementById(`step3-chart-area-${idx}`);
      if (result && areaEl && !_charts.has(areaEl.id)) {
        const settings = _getSettings(result.question_code, result.type_code);
        _renderChartInArea(areaEl, result, settings, d.axis_categories, d.axis_totals);
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

  // レポートに追加
  const addReportBtn = e.target.closest(".step3-add-report-btn");
  if (addReportBtn) {
    const crId = addReportBtn.dataset.crId;
    const cr = (AppState.chartResults ?? []).find(r => r.id === crId);
    if (!cr) { showToast("集計結果が見つかりません。先にグラフ生成を実行してください。", true); return; }
    // type_code 依存のデフォルト込みで設定を取得
    const s3 = _getSettings(cr.question_code, cr.type_code);
    const existing = findDuplicateReportPage(cr.id);
    if (existing) {
      _showDuplicateModal(cr, s3, existing);
    } else {
      addReportPageFromStep3(cr, s3);
      setActivePanel("report");
      showToast("レポートに追加しました。");
    }
    return;
  }

  // グラフ高さ「自動」ボタン
  const heightResetBtn = e.target.closest(".step3-chart-height-reset-btn");
  if (heightResetBtn) {
    const idx = parseInt(heightResetBtn.dataset.idx, 10);
    setStep3Setting(heightResetBtn.dataset.q, "chartHeight", null);
    const areaEl = document.getElementById(`step3-chart-area-${idx}`);
    if (areaEl) {
      areaEl.style.height = "";
      const chart = _charts.get(areaEl.id);
      if (chart && !Array.isArray(chart)) chart.resize();
    }
    const ctrl = heightResetBtn.closest(".step3-height-ctrl");
    if (ctrl) {
      const slider = ctrl.querySelector(".step3-chart-height-slider");
      if (slider) slider.value = 270;
      const valEl = ctrl.querySelector(".step3-chart-height-val");
      if (valEl) valEl.textContent = "自動";
    }
    return;
  }

  // 一括適用
  if (e.target.closest(".step3-bulk-apply-btn")) {
    _handleBulkApply();
  }
}

// ---------------------------------------------------------------------------
// グラフのみ再描画
// ---------------------------------------------------------------------------

function _rerenderQuestion(idx) {
  const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
  if (!d) return;
  // composite split モードの場合は全体再描画
  if (d.secondary_axis_question_code && AppState.step3CompositeDisplayMode === "split") {
    _rerenderCompositeAll();
    return;
  }
  const result = d.results[idx];
  if (!result) return;
  const areaEl = document.getElementById(`step3-chart-area-${idx}`);
  if (!areaEl) return;
  const settings = _getSettings(result.question_code, result.type_code);
  if (d.secondary_axis_question_code) _applyCompositeColorLookup(d.axis_categories);
  if (settings.splitMode === "by_axis" || settings.splitMode === "by_comparison") {
    _renderSplitInArea(areaEl, result, settings, d.axis_categories, d.axis_totals, settings.splitMode);
  } else {
    _renderChartInArea(areaEl, result, settings, d.axis_categories, d.axis_totals);
  }
  _compositeColorPaletteLookup = null;
}

// グラフ + 表の両方を再描画（ソート変更時）
function _rerenderQuestionFull(idx) {
  const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
  if (!d) return;
  // split モードの場合は全体再描画
  if (d.secondary_axis_question_code && AppState.step3CompositeDisplayMode === "split") {
    _rerenderCompositeAll();
    return;
  }
  const result = d.results[idx];
  if (!result) return;
  const settings = _getSettings(result.question_code, result.type_code);

  const areaEl = document.getElementById(`step3-chart-area-${idx}`);
  if (areaEl) {
    if (d.secondary_axis_question_code) _applyCompositeColorLookup(d.axis_categories);
    if (settings.splitMode === "by_axis" || settings.splitMode === "by_comparison") {
      _renderSplitInArea(areaEl, result, settings, d.axis_categories, d.axis_totals, settings.splitMode);
    } else {
      _renderChartInArea(areaEl, result, settings, d.axis_categories, d.axis_totals);
    }
    _compositeColorPaletteLookup = null;
  }

  const hidden = settings.hiddenChoices ?? [];
  const sortedResult = {
    ...result,
    rows: _sortedRows(result.rows.filter(r => !hidden.includes(r.label)), settings.sortOrder),
  };
  const tp = settings.transpose ?? false;
  // stacked100 は常に構成比モードで表示
  const effectiveAggMode = settings.chartType === "stacked100" ? "composition" : (settings.aggMode ?? "col_pct");
  const pctPanel = document.getElementById(`step3-tab-pct-${idx}`);
  const nPanel   = document.getElementById(`step3-tab-n-${idx}`);
  const stc = settings.showTotalCol ?? true;
  if (pctPanel) pctPanel.innerHTML = _buildPctTable(sortedResult, d.axis_categories, d.axis_totals, tp, effectiveAggMode, stc);
  if (nPanel) nPanel.innerHTML = _buildNTable(sortedResult, d.axis_categories, d.axis_totals, tp, stc);
}

// flat/nested 用: composite ラベルから色解決ラベルを設定
function _applyCompositeColorLookup(compositeLabels) {
  const priority = AppState.step3ColorPriority;
  const SEP = _COMPOSITE_SEP;
  if (priority === "axis1") {
    _compositeColorPaletteLookup = compositeLabels.map(l => l.split(SEP)[1] ?? l);
  } else if (priority === "axis2") {
    _compositeColorPaletteLookup = compositeLabels.map(l => l.split(SEP)[0] ?? l);
  } else {
    _compositeColorPaletteLookup = null;
  }
}

// split モード全体再描画
function _rerenderCompositeAll() {
  const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
  const container = document.getElementById("step3-results");
  if (container && d) {
    _destroyAllCharts();
    _clearPendingChartRenders();
    _renderResults(container, d); // async だが完了を待つ必要はない
  }
}

// ---------------------------------------------------------------------------
// 集計方法コントロールの HTML 生成・DOM 更新
// ---------------------------------------------------------------------------

const AGG_MODES = [
  { id: "col_pct",     label: "列%" },
  { id: "row_pct",     label: "行%" },
  { id: "composition", label: "構成比" },
  { id: "count",       label: "実数N" },
];

/** 集計方法ラジオボタン HTML を生成 */
function _buildAggModeHtml(idx, qCode, chartType, aggMode) {
  const isStacked = chartType === "stacked100";
  const effective = isStacked ? "composition" : aggMode;
  const radios = AGG_MODES.map(({ id, label }) => {
    const checked   = effective === id ? "checked" : "";
    const disabled  = isStacked && id !== "composition" ? "disabled" : "";
    return `<label style="font-size:.82rem; cursor:pointer${disabled ? "; opacity:.4" : ""}">
      <input type="radio" class="step3-agg-radio"
             name="step3-agg-${idx}" value="${id}"
             data-q="${_esc(qCode)}" data-idx="${idx}"
             ${checked} ${disabled}> ${label}
    </label>`;
  }).join("");
  return `<span class="step3-agg-ctrl" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap">
    集計方法：${radios}
  </span>`;
}

/** chartType 変更時に集計方法ラジオの状態を DOM 更新 */
function _updateAggRadios(idx, chartType, aggMode) {
  const isStacked = chartType === "stacked100";
  const effective = isStacked ? "composition" : aggMode;
  document.querySelectorAll(`.step3-agg-radio[data-idx="${idx}"]`).forEach(radio => {
    radio.checked  = radio.value === effective;
    radio.disabled = isStacked && radio.value !== "composition";
    radio.closest("label").style.opacity = (isStacked && radio.value !== "composition") ? "0.4" : "";
  });
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

function _toggleBarWidthCtrl(idx, chartType) {
  const bar = document.querySelector(`#step3-body-${idx} .step3-controls-bar`);
  if (!bar) return;
  const span = bar.querySelector(".step3-bar-width-ctrl");
  if (span) span.style.display = BAR_WIDTH_TYPES.has(chartType) ? "" : "none";
}

// ---------------------------------------------------------------------------
// グラフエリアへのレンダリング
// ---------------------------------------------------------------------------

function _renderChartInArea(areaEl, result, settings, axisCategories, axisTotals) {
  const { chartType, orientation, showPctLabel, sortOrder, transpose } = settings;
  // stacked100 は常に構成比モード
  const aggMode = chartType === "stacked100" ? "composition" : (settings.aggMode ?? "col_pct");

  console.debug(`[STEP3] ${result.question_code}: chartType=${chartType}, aggMode=${aggMode}, transpose=${transpose ?? false}, orientation=${orientation}`);

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
  areaEl.style.display     = "";
  areaEl.style.height      = settings.chartHeight ? settings.chartHeight + "px" : "";
  areaEl.style.aspectRatio = "";  // split mode から戻ったとき CSS class に戻す
  areaEl.style.overflow    = "";

  const hidden = settings.hiddenChoices ?? [];
  const rows   = _sortedRows(result.rows.filter(r => !hidden.includes(r.label)), sortOrder);
  const sorted = { ...result, rows };
  const isH    = orientation === "h";
  const tp     = transpose ?? false;
  const barWidth = settings.barWidth ?? null;

  if (chartType === "pie") {
    areaEl.style.display   = "flex";
    areaEl.style.flexWrap  = "wrap";
    areaEl.style.gap       = "12px";
    if (!settings.chartHeight) areaEl.style.height = "auto";
    _renderPieCharts(areaEl, sorted, axisCategories, areaKey);
    return;
  }

  areaEl.style.position = "relative";

  if (chartType === "radar") {
    const canvas = document.createElement("canvas");
    areaEl.appendChild(canvas);
    _charts.set(areaKey, new Chart(canvas, _buildRadarConfig(sorted, axisCategories)));
    return;
  }

  if (chartType === "scatter") {
    const canvas = document.createElement("canvas");
    areaEl.appendChild(canvas);
    _charts.set(areaKey, new Chart(canvas, _buildScatterConfig(sorted, axisCategories)));
    return;
  }

  const canvas = document.createElement("canvas");
  areaEl.appendChild(canvas);

  let config;
  if (chartType === "avg_bar")         config = _buildAvgBarConfig(sorted, axisCategories, showPctLabel, barWidth);
  else if (chartType === "stacked100") config = _buildStacked100Config(sorted, axisCategories, isH, showPctLabel, tp, barWidth);
  else if (chartType === "grouped")    config = _buildGroupedConfig(sorted, axisCategories, isH, showPctLabel, tp, barWidth, aggMode);
  else if (chartType === "line")       config = _buildLineConfig(sorted, axisCategories, showPctLabel, tp, aggMode);
  else                                 config = _buildBarConfig(sorted, axisCategories, isH, showPctLabel, tp, barWidth, aggMode);

  _charts.set(areaKey, new Chart(canvas, config));
}

// ---------------------------------------------------------------------------
// 分割グラフ描画
// ---------------------------------------------------------------------------

/** 仮想サブデータセット生成 (by_axis: axis_categories ごと) */
function _buildSplitByAxisDatasets(rows, axisCategories, axisTotals) {
  const choiceLabels = rows.map(r => r.label);
  return axisCategories.map((cat, ci) => ({
    target_value:    cat,
    rows: [{ label: cat, percents: rows.map(r => r.percents[ci] ?? 0), counts: rows.map(r => (r.counts ?? [])[ci] ?? 0) }],
    axis_categories: choiceLabels,
    axis_totals:     [axisTotals[ci] ?? 0],
  }));
}

/** 仮想サブデータセット生成 (by_comparison: rows ごと) */
function _buildSplitByComparisonDatasets(rows, axisCategories, axisTotals) {
  return rows.map(row => ({
    target_value:    row.label,
    rows: [{ label: row.label, percents: axisCategories.map((_, ci) => row.percents[ci] ?? 0), counts: axisCategories.map((_, ci) => (row.counts ?? [])[ci] ?? 0) }],
    axis_categories: [...axisCategories],
    axis_totals:     [...axisTotals],
  }));
}

/** 全サブチャートの共有 Y スケール上限を計算 */
function _calcSharedMax(datasets) {
  let max = 0;
  datasets.forEach(ds => ds.rows.forEach(r => r.percents.forEach(v => { if (v > max) max = v; })));
  return Math.min(100, Math.ceil(max / 10) * 10) || 100;
}

/**
 * 分割グラフをエリアに描画する。
 * mode: "by_axis" | "by_comparison"
 */
function _renderSplitInArea(areaEl, result, settings, axisCategories, axisTotals, mode) {
  const areaKey = areaEl.id;
  // 既存チャート破棄
  const existing = _charts.get(areaKey);
  if (existing) {
    (Array.isArray(existing) ? existing : [existing]).forEach(c => c.destroy());
    _charts.delete(areaKey);
  }

  const hidden      = settings.hiddenChoices ?? [];
  const filteredRows = _sortedRows(result.rows.filter(r => !hidden.includes(r.label)), settings.sortOrder);
  if (!filteredRows.length || !axisCategories.length) { areaEl.innerHTML = ""; return; }

  const datasets = mode === "by_axis"
    ? _buildSplitByAxisDatasets(filteredRows, axisCategories, axisTotals)
    : _buildSplitByComparisonDatasets(filteredRows, axisCategories, axisTotals);

  if (!datasets.length) { areaEl.innerHTML = ""; return; }

  // 共有 Y スケール
  const sharedMax = _calcSharedMax(datasets);

  // 列数 (auto: ≤2→1列, 3-4→2列, ≥5→3列)
  const n    = datasets.length;
  const cols = settings.splitColumns || (n <= 2 ? 1 : n <= 4 ? 2 : 3);

  // 各サブチャートの単一系列カラー（元データのパレットから取得）
  const paletteLabels = mode === "by_axis" ? axisCategories : filteredRows.map(r => r.label);
  const palette       = _getColorsForGraph(result.question_code, paletteLabels);

  // グリッド HTML (aspect-ratio/overflow を上書きして全グラフを表示)
  areaEl.style.display     = "";
  areaEl.style.height      = "";
  areaEl.style.position    = "";
  areaEl.style.aspectRatio = "unset";
  areaEl.style.overflow    = "visible";
  areaEl.innerHTML = `<div class="step3-split-grid" data-cols="${cols}">${
    datasets.map((ds, di) => `
      <div class="step3-split-item">
        <div class="step3-split-item-title">${_esc(ds.target_value)}<span class="step3-split-n">n=${ds.axis_totals?.[0] ?? 0}</span></div>
        <div class="step3-split-chart-wrap"><canvas id="${areaKey}-split-${di}"></canvas></div>
      </div>`).join("")
  }</div>`;

  const chartInstances = [];
  const isH      = settings.orientation === "h";
  const showLabel = settings.showPctLabel ?? true;
  const barWidth  = settings.barWidth ?? 0.9;
  const aggMode   = settings.aggMode ?? "col_pct";

  datasets.forEach((ds, di) => {
    const canvas = document.getElementById(`${areaKey}-split-${di}`);
    if (!canvas) return;
    const color  = palette[di] ?? COLORS[di % COLORS.length];
    const chart  = _buildSplitSubChart(canvas, ds, isH, showLabel, barWidth, aggMode, sharedMax, color);
    if (chart) chartInstances.push(chart);
  });
  _charts.set(areaKey, chartInstances);
}

/** 分割サブチャート 1枚分の Chart.js インスタンスを生成して返す */
function _buildSplitSubChart(canvas, ds, isH, showLabel, barWidth, aggMode, sharedMax, color) {
  const labels   = ds.axis_categories;
  const row      = ds.rows[0];
  if (!labels?.length || !row) return null;

  const data = aggMode === "count"
    ? labels.map((_, ci) => row.counts[ci] ?? 0)
    : labels.map((_, ci) => row.percents[ci] ?? 0);

  const dataset = {
    label:           row.label,
    data,
    backgroundColor: color,
    barPercentage:   barWidth,
  };

  const maxVal = aggMode === "count"
    ? Math.ceil(Math.max(...data) / 10) * 10 || 10
    : sharedMax;

  const scaleAxis = isH ? "x" : "y";
  const tickCb    = aggMode === "count" ? v => v : v => `${v}%`;
  const scales    = isH
    ? { x: { beginAtZero: true, max: maxVal, ticks: { callback: tickCb } }, y: { ticks: { font: { size: 10 } } } }
    : { x: { ticks: { font: { size: 10 }, maxRotation: 45 } }, y: { beginAtZero: true, max: maxVal, ticks: { callback: tickCb } } };

  return new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [dataset] },
    options: {
      indexAxis:           isH ? "y" : "x",
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend:     { display: false },
        tooltip:    { callbacks: { label: ctx => {
          const v = ctx.parsed ? (isH ? ctx.parsed.x : ctx.parsed.y) : null;
          return aggMode === "count"
            ? `${v !== null ? Math.round(v) : "N/A"}`
            : `${v !== null ? v.toFixed(1) : "N/A"}%`;
        }}},
        datalabels: _datalabels(showLabel, isH),
      },
      scales,
    },
  });
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

// ---------------------------------------------------------------------------
// aggMode ヘルパー
// ---------------------------------------------------------------------------

/** 行%: row の全 axis_cat counts 合計を分母として ci の割合を返す */
function _rowPct(row, ci, axisCategories) {
  const total = axisCategories.reduce((s, _, i) => s + (row.counts[i] ?? 0), 0);
  return total > 0 ? Math.round((row.counts[ci] ?? 0) / total * 1000) / 10 : 0;
}

/**
 * 構成比マトリクスを返す。[ri][ci] = その棒位置の各要素の%（合計100%）。
 * transpose=true  → 各 axis_cat の棒が 100%（列方向で正規化）
 * transpose=false → 各 row の棒が 100%（行方向で正規化）
 */
function _compositionPct(result, axisCategories, transpose) {
  if (transpose) {
    const colTotals = axisCategories.map((_, ci) =>
      result.rows.reduce((s, r) => s + (r.counts[ci] ?? 0), 0)
    );
    return result.rows.map(r =>
      axisCategories.map((_, ci) =>
        colTotals[ci] > 0 ? Math.round((r.counts[ci] ?? 0) / colTotals[ci] * 1000) / 10 : 0
      )
    );
  }
  return result.rows.map(r => {
    const total = axisCategories.reduce((s, _, ci) => s + (r.counts[ci] ?? 0), 0);
    return axisCategories.map((_, ci) =>
      total > 0 ? Math.round((r.counts[ci] ?? 0) / total * 1000) / 10 : 0
    );
  });
}

/** aggMode に応じたセル値を返す（グラフ用） */
function _getDataValue(row, ci, axisCategories, aggMode) {
  if (aggMode === "row_pct")  return _rowPct(row, ci, axisCategories);
  if (aggMode === "count")    return row.counts[ci] ?? 0;
  return row.percents[ci] ?? 0;  // "col_pct" default
}

/** aggMode に応じたツールチップラベルを返す */
function _tooltipLabel(ctx, isH, aggMode) {
  const v = ctx.parsed ? (isH ? ctx.parsed.x : ctx.parsed.y) : null;
  if (aggMode === "count") return `${ctx.dataset.label}: ${v !== null ? Math.round(v) : "N/A"}`;
  return `${ctx.dataset.label}: ${v !== null ? v.toFixed(1) : "N/A"}%`;
}

/** aggMode に応じたスケール設定（grouped / bar に使う） */
function _aggScales(isH, aggMode) {
  if (aggMode === "count") return _barScales(isH);
  return {
    ...(isH
      ? { x: { beginAtZero: true, ticks: { callback: v => `${v}%` } },
          y: { ticks: { font: { size: 10 } } } }
      : { x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: { beginAtZero: true, ticks: { callback: v => `${v}%` } } }),
  };
}

/** 棒グラフ（bar + orientation）
 *  transpose=true → labels=集計軸, datasets=選択肢（grouped 相当） */
function _buildBarConfig(result, axisCategories, isH, showPctLabel, transpose = false, barWidth = null, aggMode = "col_pct") {
  const bw = barWidth ?? 0.9;
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label: row.label,
      data:  axisCategories.map((_, ci) => _getDataValue(row, ci, axisCategories, aggMode)),
      backgroundColor: palette[ri],
      barPercentage: bw,
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label: cat,
      data:  result.rows.map(r => _getDataValue(r, ci, axisCategories, aggMode)),
      backgroundColor: palette[ci],
      barPercentage: bw,
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
        tooltip:    { callbacks: { label: ctx => _tooltipLabel(ctx, isH, aggMode) } },
        datalabels: _datalabels(showPctLabel, isH),
      },
      scales: _aggScales(isH, aggMode),
    },
  };
}

/** 100%積み上げ棒
 *  transpose=false → labels=選択肢, datasets=集計軸（行方向で正規化 → 各選択肢棒が100%）
 *  transpose=true  → labels=集計軸, datasets=選択肢（列方向で正規化 → 各軸カテゴリー棒が100%）
 *  counts を使って正確に計算する（percents の丸め誤差・MA累積を排除）。 */
function _buildStacked100Config(result, axisCategories, isH, showPctLabel, transpose = false, barWidth = null) {
  const bw = barWidth ?? 0.9;
  const comp = _compositionPct(result, axisCategories, transpose);
  // comp[ri][ci] = composition%
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label: row.label,
      data:  axisCategories.map((_, ci) => comp[ri][ci]),
      backgroundColor: palette[ri],
      barPercentage: bw,
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label: cat,
      data:  result.rows.map((_, ri) => comp[ri][ci]),
      backgroundColor: palette[ci],
      barPercentage: bw,
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
function _buildGroupedConfig(result, axisCategories, isH, showPctLabel, transpose = false, barWidth = null, aggMode = "col_pct") {
  const bw = barWidth ?? 0.9;
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, axisCategories);
    labels   = result.rows.map(r => r.label);
    datasets = axisCategories.map((cat, ci) => ({
      label: cat,
      data:  result.rows.map(r => _getDataValue(r, ci, axisCategories, aggMode)),
      backgroundColor: palette[ci],
      barPercentage: bw,
    }));
  } else {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label: row.label,
      data:  axisCategories.map((_, ci) => _getDataValue(row, ci, axisCategories, aggMode)),
      backgroundColor: palette[ri],
      barPercentage: bw,
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
        tooltip:    { callbacks: { label: ctx => _tooltipLabel(ctx, isH, aggMode) } },
        datalabels: _datalabels(showPctLabel, isH),
      },
      scales: _aggScales(isH, aggMode),
    },
  };
}

/** 平均棒（数値ラベルから加重平均を計算） */
function _buildAvgBarConfig(result, axisCategories, showPctLabel, barWidth = null) {
  const bw = barWidth ?? 0.9;
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
        barPercentage: bw,
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
function _buildLineConfig(result, axisCategories, showPctLabel, transpose = false, aggMode = "col_pct") {
  let labels, datasets;
  if (transpose) {
    const palette = _getColorsForGraph(result.question_code, result.rows.map(r => r.label));
    labels   = axisCategories;
    datasets = result.rows.map((row, ri) => ({
      label:           row.label,
      data:            axisCategories.map((_, ci) => _getDataValue(row, ci, axisCategories, aggMode)),
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
      data:            result.rows.map(r => _getDataValue(r, ci, axisCategories, aggMode)),
      borderColor:     palette[ci],
      backgroundColor: palette[ci] + "40",
      fill:            false,
      tension:         0.3,
      pointRadius:     4,
    }));
  }
  const isPct = aggMode !== "count";
  return {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => isPct
          ? `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? "N/A"}%`
          : `${ctx.dataset.label}: ${ctx.parsed.y !== null ? Math.round(ctx.parsed.y) : "N/A"}` } },
        datalabels: showPctLabel
          ? { display: true, formatter: v => isPct ? `${v.toFixed(1)}%` : Math.round(v), font: { size: 9 }, color: "#555", anchor: "end", align: "top", clamp: true }
          : { display: false },
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
        y: { beginAtZero: true, ticks: { callback: v => isPct ? `${v}%` : v } },
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

function _buildBulkBar() {
  const chartOptions = CHART_TYPES.map(t =>
    `<option value="${t.id}">${_esc(t.label)}</option>`
  ).join("");

  const colorOptions = [
    `<option value="__step1__">STEP1設定</option>`,
    `<option value="__none__">単色化（グレー）</option>`,
    ...FIXED_PALETTE_ORDER.map(key => {
      const p = FIXED_PALETTES[key];
      return `<option value="${_esc(key)}">${_esc(p.label)}</option>`;
    }),
    ...(AppState.userPalettes ? Object.values(AppState.userPalettes).map(p =>
      `<option value="${_esc(p.paletteId)}">${_esc(p.name)}</option>`
    ) : []),
  ].join("");

  return `<div class="card step3-bulk-card" style="margin-bottom:8px">
    <div class="card-body" style="padding:10px 16px">
      <div style="font-size:.82rem; font-weight:600; color:var(--color-text-muted); margin-bottom:8px">一括変更</div>
      <div class="step3-bulk-form">
        <span class="step3-bulk-label">グラフ：</span>
        <select id="step3-bulk-chart" class="step3-bulk-field">${chartOptions}</select>

        <span class="step3-bulk-label">方向：</span>
        <label style="font-size:.85rem; cursor:pointer"><input type="radio" name="step3-bulk-orient" value="v" checked> 縦</label>
        <label style="font-size:.85rem; cursor:pointer"><input type="radio" name="step3-bulk-orient" value="h"> 横</label>

        <span class="step3-bulk-label">ソート：</span>
        <select id="step3-bulk-sort" class="step3-bulk-field">
          <option value="original">元順</option>
          <option value="desc">降順</option>
          <option value="asc">昇順</option>
        </select>

        <label style="font-size:.85rem; cursor:pointer"><input type="checkbox" id="step3-bulk-pct" checked> ％ラベル</label>

        <span class="step3-bulk-label">カラー：</span>
        <select id="step3-bulk-color" class="step3-bulk-field">${colorOptions}</select>

        <span class="step3-bulk-label">表示方向：</span>
        <label style="font-size:.85rem; cursor:pointer"><input type="radio" name="step3-bulk-transpose" value="false" checked> 通常</label>
        <label style="font-size:.85rem; cursor:pointer"><input type="radio" name="step3-bulk-transpose" value="true"> 行列入替</label>

        <span class="step3-bulk-label">高さ：</span>
        <select id="step3-bulk-height" class="step3-bulk-field">
          <option value="">自動（16:9）</option>
          <option value="200">小（200px）</option>
          <option value="270">中（270px）</option>
          <option value="360">大（360px）</option>
          <option value="450">特大（450px）</option>
          <option value="540">最大（540px）</option>
        </select>

        <span class="step3-bulk-label">棒の太さ：</span>
        <input type="range" id="step3-bulk-bar-width" min="10" max="100" step="5" value="90" style="width:70px; accent-color:var(--color-primary,#3B82F6)">
        <span id="step3-bulk-bar-width-val" style="font-size:.82rem; min-width:30px">90%</span>

        <button class="btn btn-primary btn-sm step3-bulk-apply-btn" style="margin-left:auto">一括適用</button>
      </div>
    </div>
  </div>`;
}

function _handleBulkApply() {
  const data = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
  if (!data) return;

  if (!confirm("現在の個別設定をすべて上書きします。\nよろしいですか？")) return;

  const chartType    = document.getElementById("step3-bulk-chart")?.value ?? "bar";
  const orientation  = document.querySelector('[name="step3-bulk-orient"]:checked')?.value ?? "v";
  const sortOrder    = document.getElementById("step3-bulk-sort")?.value ?? "original";
  const showPctLabel = document.getElementById("step3-bulk-pct")?.checked ?? true;
  const colorKey     = document.getElementById("step3-bulk-color")?.value ?? "__step1__";
  const transpose    = document.querySelector('[name="step3-bulk-transpose"]:checked')?.value === "true";
  const heightVal    = document.getElementById("step3-bulk-height")?.value;
  const chartHeight  = heightVal ? parseInt(heightVal, 10) : null;
  const barWidthPct  = parseInt(document.getElementById("step3-bulk-bar-width")?.value ?? "90", 10);
  const barWidth     = barWidthPct / 100;

  const updates = {};
  data.results.forEach((result, idx) => {
    const update = { chartType, orientation, sortOrder, showPctLabel, transpose, chartHeight, barWidth };
    if (colorKey !== "__step1__") {
      update.selectedPalette = colorKey;
      update.customColors = null;
      update.overriddenSeriesColors = {};
    }
    updates[result.question_code] = update;

    document.querySelectorAll(`.step3-chart-btn[data-q="${result.question_code}"]`)
      .forEach(b => b.classList.toggle("active", b.dataset.chart === chartType));
    _toggleOrientCtrl(idx, chartType);
    _toggleBarWidthCtrl(idx, chartType);
    // 高さを DOM に直接適用
    const areaEl = document.getElementById(`step3-chart-area-${idx}`);
    if (areaEl) areaEl.style.height = chartHeight ? chartHeight + "px" : "";
    _rerenderQuestionFull(idx);
  });

  if (colorKey === "__step1__") {
    clearQuestionColorStateBulk(data.results.map(r => r.question_code));
  }
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
  const tp  = settings.transpose ?? false;
  const stc = settings.showTotalCol ?? true;
  const aggMode = settings.chartType === "stacked100" ? "composition" : (settings.aggMode ?? "col_pct");

  return `<div class="step3-tab-area">
    <div class="step3-tab-bar">
      <button class="step3-tab-btn active" data-tab-target="${pctId}">％表</button>
      <button class="step3-tab-btn"        data-tab-target="${nId}">N表</button>
    </div>
    <div id="${pctId}" class="step3-tab-panel">
      ${_buildPctTable(sorted, axisCategories, axisTotals, tp, aggMode, stc)}
    </div>
    <div id="${nId}" class="step3-tab-panel" hidden>
      ${_buildNTable(sorted, axisCategories, axisTotals, tp, stc)}
    </div>
  </div>`;
}

function _buildPctTable(result, axisCategories, axisTotals, transpose = false, aggMode = "col_pct", showTotalCol = true) {
  const aggLabel = { col_pct: "列%", row_pct: "行%", composition: "構成比", count: "実数N" }[aggMode] ?? "列%";
  const isCountMode = aggMode === "count";
  const comp = aggMode === "composition" ? _compositionPct(result, axisCategories, transpose) : null;

  function cellVal(row, ci, ri) {
    if (isCountMode)               return `${row.counts[ci] ?? 0}`;
    if (aggMode === "row_pct")     return `${_rowPct(row, ci, axisCategories).toFixed(1)}%`;
    if (aggMode === "composition") return `${comp[ri][ci].toFixed(1)}%`;
    return `${row.percents[ci]?.toFixed(1) ?? "0.0"}%`;
  }

  const tdStyle        = `text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap`;
  const thStyle        = `text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem`;
  const rowLabelStyle  = `padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis`;
  const totalThStyle   = `${thStyle}; font-weight:700; background:var(--color-surface-2,#F8F8F8)`;
  const totalTdBase    = `${tdStyle}; font-weight:600; background:var(--color-surface-2,#F8F8F8)`;
  const totalN         = axisTotals.reduce((s, v) => s + (v ?? 0), 0);

  function _calcRowTotal(row, ri) {
    if (isCountMode) {
      return { str: String((row.counts ?? []).slice(0, axisCategories.length).reduce((s, v) => s + (v ?? 0), 0)), isAnomaly: false };
    }
    const sum = axisCategories.reduce((s, _, ci) => {
      const v = parseFloat(cellVal(row, ci, ri));
      return s + (isNaN(v) ? 0 : v);
    }, 0);
    return { str: `${sum.toFixed(1)}%`, isAnomaly: sum < 99.5 || sum > 100.5 };
  }

  function _calcAxisTotal(ci) {
    if (isCountMode) {
      return { str: String(result.rows.reduce((s, row) => s + (row.counts[ci] ?? 0), 0)), isAnomaly: false };
    }
    const sum = result.rows.reduce((s, row, ri) => {
      const v = parseFloat(cellVal(row, ci, ri));
      return s + (isNaN(v) ? 0 : v);
    }, 0);
    return { str: `${sum.toFixed(1)}%`, isAnomaly: sum < 99.5 || sum > 100.5 };
  }

  const totalThHtml = showTotalCol
    ? `<th style="${totalThStyle}">合計<br><span style="font-weight:400; color:var(--color-text-muted)">${isCountMode ? totalN : "n=" + totalN}</span></th>`
    : "";

  if (transpose) {
    const headerCols = totalThHtml + result.rows
      .map(row => `<th style="${thStyle}" title="${_esc(row.label)}">${_esc(row.label)}</th>`)
      .join("");
    const rows = axisCategories.map((cat, ci) => {
      const { str, isAnomaly } = _calcAxisTotal(ci);
      const totalTdHtml = showTotalCol
        ? `<td style="${totalTdBase}${isAnomaly ? "; color:var(--color-danger,#EF4444)" : ""}">${str}</td>`
        : "";
      const cells = result.rows.map((row, ri) => `<td style="${tdStyle}">${cellVal(row, ci, ri)}</td>`).join("");
      return `<tr><td style="${rowLabelStyle}" title="${_esc(cat)}">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted); font-size:.75rem">n=${axisTotals[ci] ?? 0}</span></td>${totalTdHtml}${cells}</tr>`;
    }).join("");
    return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
      <thead style="background:var(--color-surface-2,#F8F8F8)">
        <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">集計軸 <span style="font-weight:400; color:var(--color-text-muted); font-size:.75rem">${aggLabel}</span></th>${headerCols}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // 通常: 行=選択肢, 列=集計軸カテゴリー
  const headerCols = totalThHtml + axisCategories
    .map((cat, i) => `<th style="${thStyle}">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted)">n=${axisTotals[i] ?? 0}</span></th>`)
    .join("");
  const rows = result.rows.map((row, ri) => {
    const { str, isAnomaly } = _calcRowTotal(row, ri);
    const totalTdHtml = showTotalCol
      ? `<td style="${totalTdBase}${isAnomaly ? "; color:var(--color-danger,#EF4444)" : ""}">${str}</td>`
      : "";
    const cells = axisCategories.map((_, ci) => `<td style="${tdStyle}">${cellVal(row, ci, ri)}</td>`).join("");
    return `<tr><td style="${rowLabelStyle}" title="${_esc(row.label)}">${_esc(row.label)}</td>${totalTdHtml}${cells}</tr>`;
  }).join("");
  return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
    <thead style="background:var(--color-surface-2,#F8F8F8)">
      <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">選択肢 <span style="font-weight:400; color:var(--color-text-muted); font-size:.75rem">${aggLabel}</span></th>${headerCols}</tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function _buildNTable(result, axisCategories, axisTotals, transpose = false, showTotalCol = true) {
  const thStyle       = `text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem`;
  const tdStyle       = `text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap`;
  const rowLabelStyle = `padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis`;
  const totalThStyle  = `${thStyle}; font-weight:700; background:var(--color-surface-2,#F8F8F8)`;
  const totalTdStyle  = `${tdStyle}; font-weight:600; background:var(--color-surface-2,#F8F8F8)`;
  const totalN        = axisTotals.reduce((s, v) => s + (v ?? 0), 0);
  const totalThHtml   = showTotalCol
    ? `<th style="${totalThStyle}">合計<br><span style="font-weight:400; color:var(--color-text-muted)">n=${totalN}</span></th>`
    : "";

  if (transpose) {
    const headerCols = totalThHtml + result.rows
      .map(row => `<th style="${thStyle}" title="${_esc(row.label)}">${_esc(row.label)}</th>`)
      .join("");
    const rows = axisCategories.map((cat, ci) => {
      const rowTotal = result.rows.reduce((s, row) => s + (row.counts[ci] ?? 0), 0);
      const totalTdHtml = showTotalCol ? `<td style="${totalTdStyle}">${rowTotal}</td>` : "";
      const cells = result.rows.map(row => `<td style="${tdStyle}">${row.counts[ci] ?? 0}</td>`).join("");
      return `<tr><td style="${rowLabelStyle}" title="${_esc(cat)}">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted); font-size:.75rem">n=${axisTotals[ci] ?? 0}</span></td>${totalTdHtml}${cells}</tr>`;
    }).join("");
    return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
      <thead style="background:var(--color-surface-2,#F8F8F8)">
        <tr><th style="text-align:left; padding:4px 8px; font-size:.8rem">集計軸</th>${headerCols}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // 通常: 行=選択肢, 列=集計軸カテゴリー
  const headerCols = totalThHtml + axisCategories
    .map((cat, i) => `<th style="${thStyle}">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted)">n=${axisTotals[i] ?? 0}</span></th>`)
    .join("");
  const rows = result.rows.map(row => {
    const rowTotal = (row.counts ?? []).slice(0, axisCategories.length).reduce((s, v) => s + (v ?? 0), 0);
    const totalTdHtml = showTotalCol ? `<td style="${totalTdStyle}">${rowTotal}</td>` : "";
    const cells = axisCategories.map((_, i) => `<td style="${tdStyle}">${row.counts[i] ?? 0}</td>`).join("");
    return `<tr><td style="${rowLabelStyle}" title="${_esc(row.label)}">${_esc(row.label)}</td>${totalTdHtml}${cells}</tr>`;
  }).join("");
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
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views?.[viewId];
  const s = view?.questionSettings?.[questionCode]
    ?? AppState.step3QuestionSettings[questionCode]
    ?? {};
  let chartType = s.chartType ?? _recommendedType(typeCode);
  // 旧 hbar/vbar の動的マイグレーション
  if (chartType === "hbar") chartType = "bar";
  if (chartType === "vbar") chartType = "bar";
  const defaultH = ["MA", "ML", "M", "SL"].includes(typeCode);
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
    chartHeight:            s.chartHeight            ?? null,
    barWidth:               s.barWidth               ?? null,
    aggMode:                s.aggMode                ?? "col_pct",
    splitMode:              s.splitMode              ?? "normal",
    splitColumns:           s.splitColumns           ?? null,
    itemsPerPage:           s.itemsPerPage           ?? null,
    pageLayout:             s.pageLayout             ?? "auto",
    showTotalCol:           s.showTotalCol           ?? true,
  };
}

function _recommendedType(typeCode) {
  return RECOMMENDED_CHART[typeCode] ?? "bar";
}

function _recommendedLabel(typeCode) {
  const type = _recommendedType(typeCode);
  const base = _chartLabel(type);
  if (type === "bar") {
    const defaultH = ["MA", "ML", "M", "SL"].includes(typeCode);
    return base + (defaultH ? "（横）" : "（縦）");
  }
  return base;
}

function _chartLabel(id) {
  return CHART_TYPES.find(t => t.id === id)?.label ?? id;
}

const _BRACKET_RE = /^(.+)\[\d+\]$/;

function _getAxisCandidates() {
  const step2Candidates = AppState.step2AxisCandidates;
  const matchedCols    = AppState.step2MatchedColumns;

  if (!matchedCols.length && !step2Candidates.length) return [];

  const step2Codes = new Set(step2Candidates.map(c => c.question_code));

  const bracketBaseCodes = new Set();
  for (const col of matchedCols) {
    const m = _BRACKET_RE.exec(col);
    if (m) bracketBaseCodes.add(m[1]);
  }

  return [...new Set([...step2Codes, ...bracketBaseCodes])];
}

function _getAxisLabel(code) {
  const q = AppState.questions.find(q => q.question_code === code);
  return q ? (q.stub || q.question_text || code) : code;
}

const _MA_AXIS_TYPES = new Set(["MA", "M", "ML"]);

// セレクター表示用: ラベルテキストと種別バッジを返す
function _getAxisSelectorLabel(code) {
  const q = AppState.questions.find(q => q.question_code === code);
  const text    = q ? (q.stub || q.question_text || code) : code;
  const typeUp  = (q?.type_code ?? "").toUpperCase();
  const isBracket = _BRACKET_RE.test(
    AppState.step2MatchedColumns.find(col => {
      const m = _BRACKET_RE.exec(col);
      return m && m[1] === code;
    }) ?? ""
  );
  const badge = (_MA_AXIS_TYPES.has(typeUp) || isBracket) ? "選択肢展開" : "通常カテゴリ";
  return { text, badge };
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

// モーダル内での色を overrides > fixedColor > valueColorMapping(ファジー) > palette > COLORS で計算
function _deriveModalColors(labels) {
  const palette = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
  return labels.map((l, i) => {
    if (_colorModalOverrides[l]) return _colorModalOverrides[l];
    const fc = _fixedColorFor(l);
    if (fc) return fc;
    const mc = _matchValueColorMapping(l, _colorModalValueMapping);
    if (mc) return mc;
    if (palette) { const pc = palette.colorFor(l); if (pc) return pc; }
    return COLORS[i % COLORS.length];
  });
}

function _openColorModal(idx) {
  const data = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
  if (!data) return;
  const result   = data.results[idx];
  if (!result) return;
  const settings = _getSettings(result.question_code, result.type_code);
  const labels   = _getColorSeriesLabels(result, settings, data.axis_categories);
  _colorModalIdx    = idx;
  _colorModalLabels = labels;

  const _rsViewId = AppState.step3ActiveViewId;
  const _rsView   = AppState.step3Views?.[_rsViewId];
  const rawSettings = _rsView?.questionSettings?.[result.question_code]
    ?? AppState.step3QuestionSettings[result.question_code]
    ?? {};
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

  // valueColorMapping: 保存済み → 復元、なければパレットのcanonicalValuesを展開
  if (rawSettings.valueColorMapping?.length > 0) {
    _colorModalValueMapping = rawSettings.valueColorMapping.map(e => ({ ...e }));
  } else {
    const pal = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
    _colorModalValueMapping = pal?.canonicalValues ? pal.canonicalValues.map(e => ({ ...e })) : null;
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

  // 値↔色対応（canonicalValues編集エリア）
  const vmEl = document.getElementById("step3-value-mapping-rows");
  if (vmEl) {
    if (_colorModalValueMapping?.length > 0) {
      vmEl.innerHTML = _colorModalValueMapping.map((entry, i) => `
        <div class="step3-vm-row" data-vi="${i}">
          <input type="color" class="step3-vm-color" value="${entry.color}" data-vi="${i}">
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${entry.color};margin-right:4px;vertical-align:middle;flex-shrink:0"></span>
          <input type="text" class="step3-vm-label" value="${_esc(entry.label)}" placeholder="値名" data-vi="${i}" style="flex:1;font-size:.82rem;padding:2px 6px;border:1px solid var(--color-border);border-radius:3px;min-width:0">
          <button class="step3-vm-del btn btn-secondary btn-sm" data-vi="${i}" style="padding:1px 6px;font-size:.78rem">✕</button>
        </div>`).join("");
    } else {
      vmEl.innerHTML = `<div style="font-size:.78rem;color:var(--color-text-muted);padding:4px 0">パレットを選択すると値↔色対応が表示されます</div>`;
    }
  }

  // 実系列への適用プレビュー（ファジーマッチ後の色）
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
  const data = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
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

  // パレットボタンクリック → 選択状態更新 + valueColorMappingをcanonicalValuesで上書き
  document.getElementById("step3-palette-btns")?.addEventListener("click", e => {
    const btn = e.target.closest(".step3-palette-swatch");
    if (!btn) return;
    const key = btn.dataset.palette;
    _colorModalPaletteKey = key === "__none__" ? null : key;
    const pal = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
    _colorModalValueMapping = pal?.canonicalValues ? pal.canonicalValues.map(e => ({ ...e })) : null;
    _refreshColorModal(_colorModalLabels);
  });

  // 「このパレットを適用」→ 全上書きをクリアしてパレット色を一括適用
  document.getElementById("step3-palette-apply-btn")?.addEventListener("click", () => {
    _colorModalOverrides = {};
    const pal = _colorModalPaletteKey ? FIXED_PALETTES[_colorModalPaletteKey] : null;
    _colorModalValueMapping = pal?.canonicalValues ? pal.canonicalValues.map(e => ({ ...e })) : _colorModalValueMapping;
    _refreshColorModal(_colorModalLabels);
  });

  // 値↔色対応: 色変更
  document.getElementById("step3-value-mapping-rows")?.addEventListener("input", e => {
    const colorInput = e.target.closest(".step3-vm-color");
    const labelInput = e.target.closest(".step3-vm-label");
    if (colorInput && _colorModalValueMapping) {
      const i = parseInt(colorInput.dataset.vi, 10);
      _colorModalValueMapping[i].color = colorInput.value;
      // スウォッチも即時更新
      const swatch = colorInput.nextElementSibling;
      if (swatch) swatch.style.background = colorInput.value;
      _refreshColorPreview(_colorModalLabels);
    } else if (labelInput && _colorModalValueMapping) {
      const i = parseInt(labelInput.dataset.vi, 10);
      _colorModalValueMapping[i].label = labelInput.value;
    }
  });

  // 値↔色対応: 削除
  document.getElementById("step3-value-mapping-rows")?.addEventListener("click", e => {
    const delBtn = e.target.closest(".step3-vm-del");
    if (!delBtn || !_colorModalValueMapping) return;
    const i = parseInt(delBtn.dataset.vi, 10);
    _colorModalValueMapping.splice(i, 1);
    _refreshColorModal(_colorModalLabels);
  });

  // 値↔色対応: 追加
  document.getElementById("step3-value-mapping-add")?.addEventListener("click", () => {
    if (!_colorModalValueMapping) _colorModalValueMapping = [];
    _colorModalValueMapping.push({ label: "", color: "#999999" });
    _refreshColorModal(_colorModalLabels);
    // 追加した行の入力欄にフォーカス
    const vmEl = document.getElementById("step3-value-mapping-rows");
    vmEl?.querySelector(".step3-vm-row:last-child .step3-vm-label")?.focus();
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
    const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
    const result = d?.results[_colorModalIdx];
    if (!result) return;
    clearQuestionColorState(result.question_code);
    _reRenderCard(_colorModalIdx);
    modal.hidden = true;
  });

  // 「現在のグラフだけ変更」→ 新形式で保存（valueColorMapping含む）
  document.getElementById("step3-color-apply-one")?.addEventListener("click", () => {
    const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
    const result = d?.results[_colorModalIdx];
    if (!result) return;
    setStep3Setting(result.question_code, "selectedPalette",        _colorModalPaletteKey);
    setStep3Setting(result.question_code, "valueColorMapping",      _colorModalValueMapping ? [..._colorModalValueMapping] : null);
    setStep3Setting(result.question_code, "overriddenSeriesColors",  { ..._colorModalOverrides });
    setStep3Setting(result.question_code, "customColors",            null);
    _reRenderCard(_colorModalIdx);
    modal.hidden = true;
  });

  // 「同じ集計軸すべてに適用」→ 全設問に新形式で保存（valueColorMapping含む）
  document.getElementById("step3-color-apply-all")?.addEventListener("click", () => {
    const allResults = ((_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData)?.results ?? [];
    const palette    = _colorModalPaletteKey;
    const vm         = _colorModalValueMapping ? [..._colorModalValueMapping] : null;
    const overrides  = { ..._colorModalOverrides };
    const updates    = {};
    allResults.forEach(r => {
      updates[r.question_code] = { selectedPalette: palette, valueColorMapping: vm, overriddenSeriesColors: overrides, customColors: null };
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
    const d = (_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData;
    const result = d?.results[_colorModalIdx];
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
    const allResults = ((_currentCacheKey && _crosstabCache[_currentCacheKey]) || _lastCrosstabData)?.results ?? [];
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

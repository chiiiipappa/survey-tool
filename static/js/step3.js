/**
 * STEP3: クロス集計・グラフ作成パネル。
 *
 * 設問ごとに棒グラフ向き・%ラベル・ソート・折りたたみ・除外を設定可能。
 * 設定は AppState.step3QuestionSettings に保持してプロジェクト保存対象。
 */
import { AppState, setStep3ActiveAxis, setStep3Setting, setStep3SettingsBulk } from "./state.js";
import { generateCrosstab } from "./api.js";

// ---------------------------------------------------------------------------
// グラフ種別定義
// ---------------------------------------------------------------------------

const CHART_TYPES = [
  { id: "bar",        label: "棒グラフ" },
  { id: "stacked100", label: "100%積み上げ" },
  { id: "pie",        label: "円グラフ" },
  { id: "grouped",    label: "grouped棒" },
  { id: "avg_bar",    label: "平均棒" },
  { id: "table_only", label: "表のみ" },
];

const RECOMMENDED_CHART = {
  SA: "bar", S: "bar",
  MA: "bar", ML: "bar", M: "bar",
  NU: "avg_bar", N: "avg_bar",
};

const ALLOWED_CHARTS = {
  SA: ["bar", "pie", "stacked100", "grouped", "table_only"],
  S:  ["bar", "pie", "stacked100", "grouped", "table_only"],
  MA: ["bar", "stacked100", "table_only"],
  ML: ["bar", "stacked100", "table_only"],
  M:  ["bar", "stacked100", "table_only"],
  NU: ["avg_bar", "table_only"],
  N:  ["avg_bar", "table_only"],
};
const ALLOWED_CHARTS_DEFAULT = ["bar", "stacked100", "pie", "grouped", "avg_bar", "table_only"];

// 向き選択が有効なチャートタイプ
const ORIENTATION_TYPES = new Set(["bar", "stacked100", "grouped"]);

const COLORS = [
  "#4299E1", "#F6AD55", "#68D391", "#F687B3", "#9F7AEA",
  "#76E4F7", "#FC8181", "#B7EE8F", "#F6E05E", "#90CDF4",
];

// Chart.js インスタンス管理
const _charts = new Map();
// 最後に取得したクロス集計データ（再描画用キャッシュ）
let _lastCrosstabData = null;

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
  axis_categories.forEach((cat, i) => {
    const color = COLORS[i % COLORS.length];
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
    </div>
  </div>`;

  // 設問ごとのカード
  results.forEach((result, idx) => {
    const settings = _getSettings(result.question_code, result.type_code);
    const recommended = _recommendedType(result.type_code);
    const recommendedLabel = _recommendedLabel(result.type_code);
    const allowed = _allowedTypes(result.type_code);

    const options = allowed
      .map(id => {
        const lbl = _chartLabel(id);
        const sel = id === settings.chartType ? " selected" : "";
        return `<option value="${id}"${sel}>${_esc(lbl)}</option>`;
      })
      .join("");

    // 向きラジオ（bar/stacked100/grouped のみ）
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
        <div style="display:flex; gap:6px; flex-shrink:0">
          <button class="btn btn-secondary btn-sm step3-exclude-btn"
                  data-q="${_esc(result.question_code)}" data-idx="${idx}"
                  data-excluded="${settings.excluded}">
            ${settings.excluded ? "出力対象に戻す" : "除外する"}
          </button>
          <button class="btn btn-secondary btn-sm step3-collapse-btn"
                  data-q="${_esc(result.question_code)}" data-idx="${idx}">
            ${settings.collapsed ? "展開 ▼" : "折りたたむ ▲"}
          </button>
        </div>
      </div>

      <!-- 折りたたみ可能ボディ -->
      <div id="step3-body-${idx}"${settings.collapsed ? " hidden" : ""}>

        <!-- グラフ設定バー -->
        <div class="step3-controls-bar">
          <span style="font-size:.78rem; color:var(--color-text-muted)">推奨: ${_esc(recommendedLabel)}</span>
          <select class="step3-chart-type-select" data-q="${_esc(result.question_code)}" data-idx="${idx}">
            ${options}
          </select>
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
        </div>

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

  // グラフ種別セレクト
  const chartSel = e.target.closest(".step3-chart-type-select");
  if (chartSel) {
    const qCode = chartSel.dataset.q;
    const idx   = parseInt(chartSel.dataset.idx, 10);
    setStep3Setting(qCode, "chartType", chartSel.value);
    // 向きラジオの表示切替
    _toggleOrientCtrl(idx, chartSel.value);
    _rerenderQuestion(idx);
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
    const sel = document.querySelector(`.step3-chart-type-select[data-q="${qCode}"]`);
    if (sel) sel.value = recommended;
    _toggleOrientCtrl(idx, recommended);
    _rerenderQuestion(idx);
    return;
  }

  // ％ラベル checkbox (click で change より確実に検知)
  const pctCb = e.target.closest(".step3-pct-label-cb");
  if (pctCb) {
    setStep3Setting(pctCb.dataset.q, "showPctLabel", pctCb.checked);
    _rerenderQuestion(parseInt(pctCb.dataset.idx, 10));
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

  // 一括変更
  const bulkBtn = e.target.closest(".step3-bulk-btn");
  if (bulkBtn) {
    _handleBulkChange(bulkBtn.dataset.bulk);
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

  const sortedResult = { ...result, rows: _sortedRows(result.rows, settings.sortOrder) };
  const pctPanel = document.getElementById(`step3-tab-pct-${idx}`);
  const nPanel   = document.getElementById(`step3-tab-n-${idx}`);
  if (pctPanel) pctPanel.innerHTML = _buildPctTable(sortedResult,
    _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals);
  if (nPanel) nPanel.innerHTML = _buildNTable(sortedResult,
    _lastCrosstabData.axis_categories, _lastCrosstabData.axis_totals);
}

// ---------------------------------------------------------------------------
// 向きコントロールの表示切替（グラフ種別変更時）
// ---------------------------------------------------------------------------

function _toggleOrientCtrl(idx, chartType) {
  const ctrl = document.querySelector(`.step3-controls-bar [data-idx="${idx}"].step3-orient-radio`);
  // 向きラジオの親 span を取得
  const bar = document.querySelector(`#step3-body-${idx} .step3-controls-bar`);
  if (!bar) return;
  const orientSpan = bar.querySelector(".step3-orient-ctrl");
  if (orientSpan) {
    orientSpan.style.display = ORIENTATION_TYPES.has(chartType) ? "" : "none";
  }
}

// ---------------------------------------------------------------------------
// グラフエリアへのレンダリング
// ---------------------------------------------------------------------------

function _renderChartInArea(areaEl, result, settings, axisCategories, axisTotals) {
  const { chartType, orientation, showPctLabel, sortOrder } = settings;

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

  const rows   = _sortedRows(result.rows, sortOrder);
  const sorted = { ...result, rows };
  const isH    = orientation === "h";

  if (chartType === "pie") {
    areaEl.style.display   = "flex";
    areaEl.style.flexWrap  = "wrap";
    areaEl.style.gap       = "12px";
    areaEl.style.height    = "auto";
    _renderPieCharts(areaEl, sorted, axisCategories, areaKey);
    return;
  }

  areaEl.style.position = "relative";
  areaEl.style.height   = "260px";
  const canvas = document.createElement("canvas");
  areaEl.appendChild(canvas);

  let config;
  if (chartType === "avg_bar")    config = _buildAvgBarConfig(sorted, axisCategories, showPctLabel);
  else if (chartType === "stacked100") config = _buildStacked100Config(sorted, axisCategories, isH, showPctLabel);
  else if (chartType === "grouped")    config = _buildGroupedConfig(sorted, axisCategories, isH, showPctLabel);
  else                                 config = _buildBarConfig(sorted, axisCategories, isH, showPctLabel);

  _charts.set(areaKey, new Chart(canvas, config));
}

// ---------------------------------------------------------------------------
// Chart.js config ビルダー
// ---------------------------------------------------------------------------

function _datalabels(show, isH, stacked = false) {
  if (!show) return { display: false };
  if (stacked) {
    return {
      display:    ctx => (isH ? ctx.parsed.x : ctx.parsed.y) >= 5,
      anchor:     "center",
      align:      "center",
      formatter:  v => `${v.toFixed(1)}%`,
      font:       { size: 9 },
      color:      "#fff",
    };
  }
  return {
    display:    ctx => (isH ? ctx.parsed.x : ctx.parsed.y) >= 3,
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

/** 棒グラフ（bar + orientation） */
function _buildBarConfig(result, axisCategories, isH, showPctLabel) {
  const labels   = result.rows.map(r => r.label);
  const datasets = axisCategories.map((cat, ci) => ({
    label: cat,
    data:  result.rows.map(r => r.percents[ci] ?? 0),
    backgroundColor: COLORS[ci % COLORS.length],
  }));
  return {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis:            isH ? "y" : "x",
      responsive:           true,
      maintainAspectRatio:  false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => `${ctx.dataset.label}: ${(isH ? ctx.parsed.x : ctx.parsed.y).toFixed(1)}%` } },
        datalabels: _datalabels(showPctLabel, isH),
      },
      scales: _barScales(isH),
    },
  };
}

/** 100%積み上げ棒 */
function _buildStacked100Config(result, axisCategories, isH, showPctLabel) {
  const labels   = result.rows.map(r => r.label);
  const datasets = axisCategories.map((cat, ci) => ({
    label: cat,
    data:  result.rows.map(r => r.percents[ci] ?? 0),
    backgroundColor: COLORS[ci % COLORS.length],
  }));
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
        tooltip:    { callbacks: { label: ctx => `${ctx.dataset.label}: ${(isH ? ctx.parsed.x : ctx.parsed.y).toFixed(1)}%` } },
        datalabels: _datalabels(showPctLabel, isH, true),
      },
      scales: stackedScales,
    },
  };
}

/** grouped棒（軸カテゴリをX軸、選択肢をデータセット） */
function _buildGroupedConfig(result, axisCategories, isH, showPctLabel) {
  const datasets = result.rows.map((row, ri) => ({
    label: row.label,
    data:  axisCategories.map((_, ci) => row.percents[ci] ?? 0),
    backgroundColor: COLORS[ri % COLORS.length],
  }));
  const scales = isH
    ? { x: { beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } },
        y: { ticks: { font: { size: 10 } } } }
    : { x: { ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, max: 100, ticks: { callback: v => `${v}%` } } };
  return {
    type: "bar",
    data: { labels: axisCategories, datasets },
    options: {
      indexAxis:            isH ? "y" : "x",
      responsive:           true,
      maintainAspectRatio:  false,
      plugins: {
        legend:     { position: "bottom", labels: { font: { size: 11 } } },
        tooltip:    { callbacks: { label: ctx => `${ctx.dataset.label}: ${(isH ? ctx.parsed.x : ctx.parsed.y).toFixed(1)}%` } },
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
        backgroundColor: axisCategories.map((_, i) => COLORS[i % COLORS.length]),
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend:     { display: false },
        tooltip:    { callbacks: { label: ctx => `平均: ${ctx.parsed.y !== null ? ctx.parsed.y.toFixed(2) : "N/A"}` } },
        datalabels: showPctLabel ? {
          display:    ctx => ctx.parsed.y !== null,
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
  const pieColors = result.rows.map((_, ri) => COLORS[ri % COLORS.length]);
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
    const sel = document.querySelector(`.step3-chart-type-select[data-q="${result.question_code}"]`);
    if (sel) sel.value = chartType;
    _toggleOrientCtrl(idx, chartType);
    _rerenderQuestion(idx);
  });

  if (Object.keys(updates).length > 0) setStep3SettingsBulk(updates);
}

// ---------------------------------------------------------------------------
// クロス表（タブ式: ％表 / N表）
// ---------------------------------------------------------------------------

function _buildTabbedTable(result, axisCategories, axisTotals, idx, settings) {
  const pctId = `step3-tab-pct-${idx}`;
  const nId   = `step3-tab-n-${idx}`;
  const sorted = { ...result, rows: _sortedRows(result.rows, settings.sortOrder) };

  return `<div class="step3-tab-area">
    <div class="step3-tab-bar">
      <button class="step3-tab-btn active" data-tab-target="${pctId}">％表</button>
      <button class="step3-tab-btn"        data-tab-target="${nId}">N表</button>
    </div>
    <div id="${pctId}" class="step3-tab-panel">
      ${_buildPctTable(sorted, axisCategories, axisTotals)}
    </div>
    <div id="${nId}" class="step3-tab-panel" hidden>
      ${_buildNTable(sorted, axisCategories, axisTotals)}
    </div>
  </div>`;
}

function _buildPctTable(result, axisCategories, axisTotals) {
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

function _buildNTable(result, axisCategories, axisTotals) {
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
    orientation:  s.orientation  ?? (defaultH ? "h" : "v"),
    showPctLabel: s.showPctLabel ?? true,
    sortOrder:    s.sortOrder    ?? "original",
    collapsed:    s.collapsed    ?? false,
    excluded:     s.excluded     ?? false,
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

function _allowedTypes(typeCode) {
  return ALLOWED_CHARTS[typeCode] ?? ALLOWED_CHARTS_DEFAULT;
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

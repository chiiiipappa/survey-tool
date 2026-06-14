/**
 * レポート生成パネル（Phase 4: グラフ調整・カラー連携）
 */
import {
  AppState,
  setReportMode, setReportTargetColumn, setReportTargetValues,
  setReportSelectedQuestions, setReportAxisSpecs, setReportLoading,
  setReportProject, addReportProjectPages,
  updateReportProjectPage, duplicateReportProjectPage, removeReportProjectPage,
  setActiveReportPageId, setReportMainMode, getTargetValues,
} from "./state.js";
import { generateReport } from "./api.js";
import { showToast } from "./app.js";

// Chart.js インスタンス管理
const _charts = new Map();

// プレビュー再描画の重複防止
let _lastPreviewPageId = null;
let _lastPreviewMode = null;

// ---------------------------------------------------------------------------
// グラフモード定義（4列グリッド）
// ---------------------------------------------------------------------------

const CHART_MODES = [
  { id: "auto",              icon: "⊞", label: "自動" },
  { id: "hbar",              icon: "≡", label: "横棒" },
  { id: "vbar",              icon: "║", label: "縦棒" },
  { id: "grouped_hbar",      icon: "≡≡", label: "複数横棒" },
  { id: "grouped_vbar",      icon: "∥∥", label: "複数縦棒" },
  { id: "stacked100_hbar",   icon: "▓←", label: "積上横棒" },
  { id: "stacked100_vbar",   icon: "▓↑", label: "積上縦棒" },
  { id: "small_multiples",   icon: "⊠", label: "小分割" },
  { id: "brand_hbar",        icon: "🏷", label: "ブランド横" },
  { id: "brand_vbar",        icon: "🏷←", label: "ブランド縦" },
  { id: "brand_vbar_stacked",icon: "🏷▓", label: "ブランド縦\n積上" },
];

// ---------------------------------------------------------------------------
// デフォルト chartSettings
// ---------------------------------------------------------------------------

function _defaultChartSettings() {
  return {
    titleOverride: null,
    questionTextOverride: null,
    showQuestionText: true,
    subtitleFontSize: 8,
    chartMode: "auto",
    showLabels: true,
    labelDecimalPlaces: 1,
    showLegend: true,
    legendPosition: "bottom",
    showTable: false,
    // グラフサイズ
    chartHeightPx: null,
    chartWidthPx: null,
    chartMaxWidthPx: null,
    // 表示密度
    barThickness: null,
    categoryPercentage: 0.8,
    barPercentage: 0.9,
    axisFontSize: 10,
    labelFontSize: 10,
    legendFontSize: 11,
    // ラベル設定
    labelMinPercent: 2,
    labelAnchor: "center",
    labelAlign: "center",
    // 行列入れ替え
    transpose: false,
    // 選択肢フィルタ
    hiddenChoices: [],
    // 集計表設定
    tableContentMode: "percent",  // "percent" | "count" | "both"
    showTableRowTotal: false,
    showTableColTotal: false,
    tableFontSize: 9,
    tableDecimalPlaces: 1,
    // カラー設定
    colorSettings: {
      selectedPalette: null,
      valueColorMapping: null,
      overriddenSeriesColors: {},
    },
  };
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

export function initReport() {
  document.addEventListener("survey:statechange", _onStateChange);
  _bindEvents();
  _bindEditPanelEvents();
}

function _bindEvents() {
  document.getElementById("report-mode-comparison")?.addEventListener("click", () => {
    setReportMode("comparison");
    _renderModeButtons();
    _syncTargetValuesHint();
  });
  document.getElementById("report-mode-single")?.addEventListener("click", () => {
    setReportMode("single");
    _renderModeButtons();
    _syncTargetValuesHint();
  });

  document.getElementById("report-target-column")?.addEventListener("change", (e) => {
    setReportTargetColumn(e.target.value);
    _renderTargetValues();
    _syncTargetValuesHint();
  });

  document.getElementById("report-generate-btn")?.addEventListener("click", _onGenerate);

  document.getElementById("report-q-search")?.addEventListener("input", _renderQuestionList);
  document.getElementById("report-q-select-all")?.addEventListener("click", () => {
    document.querySelectorAll("#report-question-list input[type='checkbox']").forEach(cb => { cb.checked = true; });
    _syncSelectedQuestions();
  });
  document.getElementById("report-q-deselect-all")?.addEventListener("click", () => {
    document.querySelectorAll("#report-question-list input[type='checkbox']").forEach(cb => { cb.checked = false; });
    _syncSelectedQuestions();
  });

  document.getElementById("report-axis-total")?.addEventListener("change", _syncAxisSpecs);

  document.getElementById("report-add-page-btn")?.addEventListener("click", () => {
    setReportMainMode("settings");
  });

  document.getElementById("report-edit-page-btn")?.addEventListener("click", () => {
    setReportMainMode("settings");
  });
  document.getElementById("report-duplicate-page-btn")?.addEventListener("click", () => {
    const pageId = AppState.reportProject.activePageId;
    if (pageId) {
      duplicateReportProjectPage(pageId);
      _lastPreviewPageId = null;
      setReportMainMode("preview");
    }
  });
  document.getElementById("report-delete-page-btn")?.addEventListener("click", () => {
    const pageId = AppState.reportProject.activePageId;
    if (!pageId) return;
    removeReportProjectPage(pageId);
    const pages = AppState.reportProject.pages;
    setReportMainMode(pages.length > 0 ? "preview" : "settings");
  });
  document.getElementById("report-export-png-btn")?.addEventListener("click", _exportActivePng);

  // 編集タブ切替
  document.querySelectorAll(".report-edit-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".report-edit-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      document.querySelectorAll(".report-edit-tabcontent").forEach(c => {
        c.style.display = c.dataset.tabcontent === tab ? "" : "none";
      });
    });
  });
}

function _bindEditPanelEvents() {
  // タイトル
  document.getElementById("edit-title-input")?.addEventListener("input", (e) => {
    _patchChartSettings({ titleOverride: e.target.value || null });
  });
  document.getElementById("edit-title-reset-btn")?.addEventListener("click", () => {
    document.getElementById("edit-title-input").value = "";
    _patchChartSettings({ titleOverride: null });
  });

  // 設問文
  document.getElementById("edit-subtitle-input")?.addEventListener("input", (e) => {
    _patchChartSettings({ questionTextOverride: e.target.value || null });
  });
  document.getElementById("edit-subtitle-reset-btn")?.addEventListener("click", () => {
    document.getElementById("edit-subtitle-input").value = "";
    _patchChartSettings({ questionTextOverride: null });
  });
  document.getElementById("edit-show-question-text")?.addEventListener("change", (e) => {
    _patchChartSettings({ showQuestionText: e.target.checked });
  });

  // グラフ高さスライダー
  document.getElementById("edit-chart-height")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    const valEl = document.getElementById("edit-chart-height-val");
    if (valEl) valEl.textContent = v === 0 ? "自動" : `${v}px`;
    _patchChartSettings({ chartHeightPx: v === 0 ? null : v });
  });

  // ラベル表示
  document.getElementById("edit-show-labels")?.addEventListener("change", (e) => {
    _patchChartSettings({ showLabels: e.target.checked });
  });
  document.getElementById("edit-label-decimals")?.addEventListener("change", (e) => {
    _patchChartSettings({ labelDecimalPlaces: parseInt(e.target.value, 10) });
  });
  document.getElementById("edit-label-min")?.addEventListener("input", (e) => {
    _patchChartSettings({ labelMinPercent: parseFloat(e.target.value) || 0 });
  });

  // 凡例
  document.getElementById("edit-show-legend")?.addEventListener("change", (e) => {
    _patchChartSettings({ showLegend: e.target.checked });
  });
  document.getElementById("edit-legend-position")?.addEventListener("change", (e) => {
    _patchChartSettings({ legendPosition: e.target.value });
  });

  // 表示密度スライダー
  document.getElementById("edit-bar-pct")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    const valEl = document.getElementById("edit-bar-pct-val");
    if (valEl) valEl.textContent = `${v}%`;
    _patchChartSettings({ barPercentage: v / 100 });
  });
  document.getElementById("edit-cat-pct")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    const valEl = document.getElementById("edit-cat-pct-val");
    if (valEl) valEl.textContent = `${v}%`;
    _patchChartSettings({ categoryPercentage: v / 100 });
  });

  // フォントサイズ
  document.getElementById("edit-axis-font-size")?.addEventListener("input", (e) => {
    _patchChartSettings({ axisFontSize: parseInt(e.target.value, 10) || 10 });
  });
  document.getElementById("edit-label-font-size")?.addEventListener("input", (e) => {
    _patchChartSettings({ labelFontSize: parseInt(e.target.value, 10) || 10 });
  });
  document.getElementById("edit-legend-font-size")?.addEventListener("input", (e) => {
    _patchChartSettings({ legendFontSize: parseInt(e.target.value, 10) || 11 });
  });

  // 集計表
  document.getElementById("edit-show-table")?.addEventListener("change", (e) => {
    _patchChartSettings({ showTable: e.target.checked });
  });

  // カラー: STEP3同期ボタン
  document.getElementById("edit-sync-colors-btn")?.addEventListener("click", () => {
    const pageId = AppState.reportProject.activePageId;
    if (pageId) _syncColorsFromStep3(pageId);
  });

  // グラフ幅スライダー
  document.getElementById("edit-chart-width")?.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    const valEl = document.getElementById("edit-chart-width-val");
    if (valEl) valEl.textContent = v === 0 ? "自動" : `${v}px`;
    _patchChartSettings({ chartWidthPx: v === 0 ? null : v });
  });

  // 設問文フォントサイズ
  document.getElementById("edit-subtitle-font-size")?.addEventListener("input", (e) => {
    _patchChartSettings({ subtitleFontSize: parseInt(e.target.value, 10) || 8 });
  });

  // 集計表: コンテンツモード
  document.getElementById("edit-table-content-mode")?.addEventListener("change", (e) => {
    _patchChartSettings({ tableContentMode: e.target.value });
  });

  // 集計表: 合計行・列
  document.getElementById("edit-show-row-total")?.addEventListener("change", (e) => {
    _patchChartSettings({ showTableRowTotal: e.target.checked });
  });
  document.getElementById("edit-show-col-total")?.addEventListener("change", (e) => {
    _patchChartSettings({ showTableColTotal: e.target.checked });
  });

  // 集計表: フォントサイズ
  document.getElementById("edit-table-font-size")?.addEventListener("input", (e) => {
    _patchChartSettings({ tableFontSize: parseInt(e.target.value, 10) || 9 });
  });

  // 行列入れ替え
  document.getElementById("edit-transpose")?.addEventListener("change", (e) => {
    _patchChartSettings({ transpose: e.target.checked });
  });
}

function _onStateChange() {
  if (AppState.activePanel !== "report") return;

  _renderModeButtons();
  _renderTargetColumnOptions();
  _renderTargetValues();
  _syncTargetValuesHint();
  _renderQuestionList();
  _renderAxisList();
  _renderPageList();

  const activePageId = AppState.reportProject.activePageId;
  const isPreview = AppState.reportMainMode === "preview" && activePageId;
  document.getElementById("report-settings-panel").style.display = isPreview ? "none" : "";
  document.getElementById("report-preview-panel").style.display = isPreview ? "" : "none";

  if (isPreview && (activePageId !== _lastPreviewPageId || AppState.reportMainMode !== _lastPreviewMode)) {
    _lastPreviewPageId = activePageId;
    _lastPreviewMode = AppState.reportMainMode;
    const activePage = AppState.reportProject.pages.find(p => p.pageId === activePageId);
    if (activePage?.generatedData) {
      _renderPreview(activePage);
    }
  }
  if (!isPreview) {
    _lastPreviewPageId = null;
    _lastPreviewMode = null;
  }

  if (isPreview) {
    const activePage = AppState.reportProject.pages.find(p => p.pageId === activePageId);
    if (activePage) _renderEditPanel(activePage);
  }
}

// ---------------------------------------------------------------------------
// 設定フォーム描画
// ---------------------------------------------------------------------------

function _renderModeButtons() {
  const isCmp = AppState.reportMode === "comparison";
  document.getElementById("report-mode-comparison")?.classList.toggle("btn-primary", isCmp);
  document.getElementById("report-mode-comparison")?.classList.toggle("btn-secondary", !isCmp);
  document.getElementById("report-mode-single")?.classList.toggle("btn-primary", !isCmp);
  document.getElementById("report-mode-single")?.classList.toggle("btn-secondary", isCmp);
}

function _renderTargetColumnOptions() {
  const sel = document.getElementById("report-target-column");
  if (!sel) return;
  const current = AppState.reportTargetColumn;
  const SA_TYPES = new Set(["SA", "S", "NU", "N"]);
  const MA_TYPES = new Set(["MA", "M", "ML"]);
  const candidates = (AppState.questions ?? []).filter(q => {
    const tc = (q.type_code ?? "").toUpperCase();
    if (!SA_TYPES.has(tc) && !MA_TYPES.has(tc)) return false;
    if (q.has_children) return false;
    if (MA_TYPES.has(tc) && !q.choices?.length) return false;
    return true;
  });
  sel.innerHTML = `<option value="">指定なし（全体集計）</option>` +
    candidates.map(q => {
      const tc = (q.type_code ?? "").toUpperCase();
      const isMA = MA_TYPES.has(tc);
      const badge = isMA ? "【複数回答】" : "";
      const label = `${q.question_code} — ${q.stub || q.question_text}${badge ? " " + badge : ""}`;
      return `<option value="${_esc(q.question_code)}" ${q.question_code === current ? "selected" : ""}>${_esc(label)}</option>`;
    }).join("");
}

function _renderTargetValues() {
  const section = document.getElementById("report-target-values-section");
  const list = document.getElementById("report-target-values-list");
  if (!section || !list) return;
  const col = AppState.reportTargetColumn;
  if (!col) { section.style.display = "none"; return; }
  const choices = getTargetValues(col);
  if (choices.length === 0) { section.style.display = "none"; return; }
  section.style.display = "";
  const selected = new Set(AppState.reportTargetValues);
  list.innerHTML = choices.map(v =>
    `<label>
      <input type="checkbox" name="report-target-val" value="${_esc(v)}"
             ${selected.has(v) ? "checked" : ""}>
      <span>${_esc(v)}</span>
    </label>`
  ).join("");
  list.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", _syncTargetValues);
  });
}

function _syncTargetValues() {
  const vals = [...document.querySelectorAll("#report-target-values-list input:checked")]
    .map(cb => cb.value);
  setReportTargetValues(vals);
}

function _syncTargetValuesHint() {
  const hint = document.getElementById("report-target-values-hint");
  if (!hint) return;
  const col = AppState.reportTargetColumn;
  const q = (AppState.questions ?? []).find(q => q.question_code === col);
  const isMA = new Set(["MA", "M", "ML"]).has((q?.type_code ?? "").toUpperCase());
  if (AppState.reportMode === "comparison") {
    hint.textContent = isMA
      ? "（複数選択可 — 選択肢ごとに1ページ生成）"
      : "（複数選択可）";
  } else {
    hint.textContent = isMA
      ? "（1つ選択 — 選択者に絞り込み）"
      : "（1つ選択）";
  }
}

function _renderQuestionList() {
  const list = document.getElementById("report-question-list");
  if (!list) return;
  const SKIP = new Set(["FA", "OA", "OE", "FT", "FN", "XL", "F"]);
  const questions = (AppState.questions ?? []).filter(q =>
    !SKIP.has((q.type_code ?? "").toUpperCase())
  );
  const selected = new Set(AppState.reportSelectedQuestions);
  const searchVal = (document.getElementById("report-q-search")?.value ?? "").toLowerCase();
  list.innerHTML = questions
    .filter(q => {
      if (!searchVal) return true;
      return q.question_code.toLowerCase().includes(searchVal) ||
             (q.question_text ?? "").toLowerCase().includes(searchVal);
    })
    .map(q =>
      `<label>
        <input type="checkbox" name="report-q" value="${_esc(q.question_code)}"
               ${selected.has(q.question_code) ? "checked" : ""}>
        <span title="${_esc(q.question_text)}">[${_esc(q.question_code)}] ${_esc(q.stub || q.question_text)}</span>
      </label>`
    ).join("");
  list.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", _syncSelectedQuestions);
  });
}

function _syncSelectedQuestions() {
  const codes = [...document.querySelectorAll("#report-question-list input:checked")]
    .map(cb => cb.value);
  setReportSelectedQuestions(codes);
}

function _renderAxisList() {
  const list = document.getElementById("report-axis-list");
  if (!list) return;
  const AXIS_TYPES = new Set(["SA", "S", "NU", "N"]);
  const axes = (AppState.questions ?? []).filter(q =>
    AXIS_TYPES.has((q.type_code ?? "").toUpperCase()) && !q.has_children
  );
  const columnCodes = new Set(
    (AppState.reportAxisSpecs ?? []).filter(s => s.type === "column").map(s => s.column_code)
  );
  list.innerHTML = axes.map(q =>
    `<label>
      <input type="checkbox" name="report-axis" value="${_esc(q.question_code)}"
             ${columnCodes.has(q.question_code) ? "checked" : ""}>
      <span>${_esc(q.question_code)} — ${_esc(q.stub || q.question_text)}</span>
    </label>`
  ).join("");
  list.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", _syncAxisSpecs);
  });
}

function _syncAxisSpecs() {
  const specs = [];
  if (document.getElementById("report-axis-total")?.checked) {
    specs.push({ type: "total", column_code: "" });
  }
  document.querySelectorAll("#report-axis-list input:checked").forEach(cb => {
    specs.push({ type: "column", column_code: cb.value });
  });
  setReportAxisSpecs(specs);
}

// ---------------------------------------------------------------------------
// ページ一覧（左サイドバー）
// ---------------------------------------------------------------------------

function _renderPageList() {
  const ol = document.getElementById("report-page-items");
  if (!ol) return;
  const { pages, activePageId } = AppState.reportProject;
  if (pages.length === 0) {
    ol.innerHTML = `<li class="report-page-item-empty" style="padding:12px;font-size:.8rem;color:var(--color-text-muted);text-align:center;">
      ページがありません。<br>設定して「ページを追加生成」してください。
    </li>`;
    return;
  }
  ol.innerHTML = pages.map((p, i) =>
    `<li class="report-page-item${p.pageId === activePageId ? " active" : ""}" data-page-id="${_esc(p.pageId)}">
      <span class="report-page-item-num">${i + 1}</span>
      <span class="report-page-item-title">${_esc(_displayTitle(p))}</span>
    </li>`
  ).join("");
  ol.querySelectorAll(".report-page-item[data-page-id]").forEach(li => {
    li.addEventListener("click", () => {
      setActiveReportPageId(li.dataset.pageId);
      setReportMainMode("preview");
    });
  });
}

function _displayTitle(page) {
  return page.chartSettings?.titleOverride || page.title;
}

// ---------------------------------------------------------------------------
// プレビュー描画
// ---------------------------------------------------------------------------

function _renderPreview(page) {
  const canvas = document.getElementById("report-preview-canvas");
  if (!canvas) return;

  _charts.forEach(c => c.destroy());
  _charts.clear();

  canvas.innerHTML = "";
  const cs = { ..._defaultChartSettings(), ...(page.chartSettings ?? {}) };
  const el = _buildPageElement(page.generatedData, "preview", cs);
  canvas.appendChild(el);
  _renderPageChart(page.generatedData, "preview", cs);
}

// ---------------------------------------------------------------------------
// 編集パネル描画・更新
// ---------------------------------------------------------------------------

function _renderEditPanel(page) {
  const cs = { ..._defaultChartSettings(), ...(page.chartSettings ?? {}) };

  // タイトル
  const titleInput = document.getElementById("edit-title-input");
  if (titleInput && titleInput !== document.activeElement) {
    titleInput.value = cs.titleOverride ?? "";
    titleInput.placeholder = page.generatedData?.title ?? "自動生成タイトル";
  }

  // 設問文
  const subtitleInput = document.getElementById("edit-subtitle-input");
  if (subtitleInput && subtitleInput !== document.activeElement) {
    subtitleInput.value = cs.questionTextOverride ?? "";
    subtitleInput.placeholder = page.generatedData?.question_text ?? "設問文（自動取得）";
  }
  const showQtEl = document.getElementById("edit-show-question-text");
  if (showQtEl) showQtEl.checked = cs.showQuestionText;

  // グラフモード グリッド
  const grid = document.getElementById("edit-chart-mode-grid");
  if (grid) {
    grid.innerHTML = CHART_MODES.map(m =>
      `<button class="report-chart-mode-btn${cs.chartMode === m.id ? " active" : ""}"
               data-mode="${_esc(m.id)}" title="${_esc(m.label)}">
        <span class="report-chart-mode-icon">${m.icon}</span>
        <span>${_esc(m.label)}</span>
      </button>`
    ).join("");
    grid.querySelectorAll(".report-chart-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        _patchChartSettings({ chartMode: btn.dataset.mode });
      });
    });
  }

  // グラフ高さ
  const hEl = document.getElementById("edit-chart-height");
  if (hEl && hEl !== document.activeElement) {
    hEl.value = String(cs.chartHeightPx ?? 0);
    const valEl = document.getElementById("edit-chart-height-val");
    if (valEl) valEl.textContent = cs.chartHeightPx ? `${cs.chartHeightPx}px` : "自動";
  }

  // ラベル
  const showLabelsEl = document.getElementById("edit-show-labels");
  if (showLabelsEl) showLabelsEl.checked = cs.showLabels;
  const decimalsEl = document.getElementById("edit-label-decimals");
  if (decimalsEl) decimalsEl.value = String(cs.labelDecimalPlaces);
  const labelMinEl = document.getElementById("edit-label-min");
  if (labelMinEl && labelMinEl !== document.activeElement) labelMinEl.value = String(cs.labelMinPercent);

  // 凡例
  const showLegendEl = document.getElementById("edit-show-legend");
  if (showLegendEl) showLegendEl.checked = cs.showLegend;
  const legendPosEl = document.getElementById("edit-legend-position");
  if (legendPosEl) legendPosEl.value = cs.legendPosition;

  // 表示密度
  const barPctEl = document.getElementById("edit-bar-pct");
  if (barPctEl && barPctEl !== document.activeElement) {
    const v = Math.round((cs.barPercentage ?? 0.9) * 100);
    barPctEl.value = String(v);
    const valEl = document.getElementById("edit-bar-pct-val");
    if (valEl) valEl.textContent = `${v}%`;
  }
  const catPctEl = document.getElementById("edit-cat-pct");
  if (catPctEl && catPctEl !== document.activeElement) {
    const v = Math.round((cs.categoryPercentage ?? 0.8) * 100);
    catPctEl.value = String(v);
    const valEl = document.getElementById("edit-cat-pct-val");
    if (valEl) valEl.textContent = `${v}%`;
  }

  // フォントサイズ
  const axisFsEl = document.getElementById("edit-axis-font-size");
  if (axisFsEl && axisFsEl !== document.activeElement) axisFsEl.value = String(cs.axisFontSize);
  const labelFsEl = document.getElementById("edit-label-font-size");
  if (labelFsEl && labelFsEl !== document.activeElement) labelFsEl.value = String(cs.labelFontSize);
  const legendFsEl = document.getElementById("edit-legend-font-size");
  if (legendFsEl && legendFsEl !== document.activeElement) legendFsEl.value = String(cs.legendFontSize);

  // グラフ幅
  const wEl = document.getElementById("edit-chart-width");
  if (wEl && wEl !== document.activeElement) {
    wEl.value = String(cs.chartWidthPx ?? 0);
    const wValEl = document.getElementById("edit-chart-width-val");
    if (wValEl) wValEl.textContent = cs.chartWidthPx ? `${cs.chartWidthPx}px` : "自動";
  }

  // 設問文フォントサイズ
  const stFsEl = document.getElementById("edit-subtitle-font-size");
  if (stFsEl && stFsEl !== document.activeElement) stFsEl.value = String(cs.subtitleFontSize ?? 8);

  // 集計表
  const showTableEl = document.getElementById("edit-show-table");
  if (showTableEl) showTableEl.checked = cs.showTable;

  // 集計表 詳細設定
  const tcmEl = document.getElementById("edit-table-content-mode");
  if (tcmEl) tcmEl.value = cs.tableContentMode ?? "percent";
  const rowTotalEl = document.getElementById("edit-show-row-total");
  if (rowTotalEl) rowTotalEl.checked = cs.showTableRowTotal;
  const colTotalEl = document.getElementById("edit-show-col-total");
  if (colTotalEl) colTotalEl.checked = cs.showTableColTotal;
  const tableFsEl = document.getElementById("edit-table-font-size");
  if (tableFsEl && tableFsEl !== document.activeElement) tableFsEl.value = String(cs.tableFontSize ?? 9);

  // 行列入れ替え
  const transposeEl = document.getElementById("edit-transpose");
  if (transposeEl) transposeEl.checked = cs.transpose ?? false;

  // 選択肢フィルタ
  _renderChoiceFilterList(page, cs);

  // カラーリスト
  _renderColorList(page, cs);
}

function _renderColorList(page, cs) {
  const listEl = document.getElementById("edit-color-list");
  if (!listEl) return;

  // このページで使われているラベルを取得
  const labels = _getPageColorLabels(page);
  if (labels.length === 0) {
    listEl.innerHTML = `<p style="font-size:.75rem;color:var(--color-text-muted)">色設定なし（軸設定がありません）</p>`;
    return;
  }

  const overrides = cs.colorSettings?.overriddenSeriesColors ?? {};
  const resolvedColors = _resolveColorsForPage(cs, labels);

  listEl.innerHTML = labels.map((label, i) =>
    `<div class="report-color-row">
      <input type="color" class="report-color-swatch" data-label="${_esc(label)}" value="${resolvedColors[i]}">
      <span class="report-color-label" title="${_esc(label)}">${_esc(label)}</span>
    </div>`
  ).join("");

  listEl.querySelectorAll(".report-color-swatch").forEach(input => {
    input.addEventListener("input", (e) => {
      const label = e.target.dataset.label;
      const pageId = AppState.reportProject.activePageId;
      if (!pageId || !label) return;
      const page2 = AppState.reportProject.pages.find(p => p.pageId === pageId);
      const cs2 = { ..._defaultChartSettings(), ...(page2?.chartSettings ?? {}) };
      const newOverrides = { ...(cs2.colorSettings?.overriddenSeriesColors ?? {}), [label]: e.target.value };
      _patchChartSettings({
        colorSettings: {
          ...(cs2.colorSettings ?? {}),
          overriddenSeriesColors: newOverrides,
        },
      });
    });
  });
}

function _renderChoiceFilterList(page, cs) {
  const listEl = document.getElementById("edit-choice-filter-list");
  if (!listEl) return;

  const data = page.generatedData;
  if (!data) { listEl.innerHTML = ""; return; }

  // 選択肢ラベルを取得（comparison_datasets の場合は最初のデータセットのrows）
  let allLabels;
  if (data.comparison_datasets?.length) {
    allLabels = (data.comparison_datasets[0]?.rows ?? []).map(r => r.label);
  } else {
    allLabels = (data.rows ?? []).map(r => r.label);
  }

  if (!allLabels.length) {
    listEl.innerHTML = `<p style="font-size:.75rem;color:var(--color-text-muted)">選択肢がありません</p>`;
    return;
  }

  const hidden = new Set(cs.hiddenChoices ?? []);
  listEl.innerHTML = allLabels.map(label =>
    `<label class="report-choice-filter-row">
      <input type="checkbox" class="edit-choice-cb" data-label="${_esc(label)}" ${hidden.has(label) ? "" : "checked"}>
      <span style="font-size:.78rem">${_esc(label)}</span>
    </label>`
  ).join("");

  listEl.querySelectorAll(".edit-choice-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const allCbs = [...listEl.querySelectorAll(".edit-choice-cb")];
      const newHidden = allCbs.filter(c => !c.checked).map(c => c.dataset.label);
      _patchChartSettings({ hiddenChoices: newHidden });
    });
  });
}

function _getPageColorLabels(page) {
  const data = page.generatedData;
  if (!data) return [];
  if (data.comparison_datasets?.length) {
    // ブランドモードでは axis_categories を使う
    return data.comparison_datasets[0]?.axis_categories ?? [];
  }
  return data.axis_categories ?? [];
}

function _patchChartSettings(patch) {
  const pageId = AppState.reportProject.activePageId;
  if (!pageId) return;
  const page = AppState.reportProject.pages.find(p => p.pageId === pageId);
  if (!page) return;
  const next = { ..._defaultChartSettings(), ...(page.chartSettings ?? {}), ...patch };
  updateReportProjectPage(pageId, { chartSettings: next });
  _lastPreviewPageId = null;  // 強制再描画
}

function _syncColorsFromStep3(pageId) {
  const page = AppState.reportProject.pages.find(p => p.pageId === pageId);
  if (!page) return;
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views[viewId];
  const step3QS = view?.questionSettings?.[page.questionCode]
                ?? AppState.step3QuestionSettings?.[page.questionCode]
                ?? {};
  _patchChartSettings({
    colorSettings: {
      selectedPalette: step3QS.selectedPalette ?? null,
      valueColorMapping: step3QS.valueColorMapping ?? null,
      overriddenSeriesColors: {},
    },
  });
  showToast("③のカラー設定を反映しました。");
}

// ---------------------------------------------------------------------------
// レポート生成
// ---------------------------------------------------------------------------

async function _onGenerate() {
  const errEl = document.getElementById("report-generate-error");
  if (errEl) errEl.style.display = "none";

  const questionCodes = [...document.querySelectorAll("#report-question-list input:checked")]
    .map(cb => cb.value);
  if (questionCodes.length === 0) {
    _showError("分析設問を1つ以上選択してください。");
    return;
  }

  const axisSpecs = [];
  if (document.getElementById("report-axis-total")?.checked) {
    axisSpecs.push({ type: "total", column_code: "" });
  }
  document.querySelectorAll("#report-axis-list input:checked").forEach(cb => {
    axisSpecs.push({ type: "column", column_code: cb.value });
  });
  if (axisSpecs.length === 0) {
    _showError("分析軸を1つ以上選択してください。");
    return;
  }

  const targetColumn = document.getElementById("report-target-column")?.value ?? "";
  const targetValues = [...document.querySelectorAll("#report-target-values-list input:checked")]
    .map(cb => cb.value);

  setReportLoading(true);
  document.getElementById("report-generate-btn").disabled = true;

  try {
    const resp = await generateReport(
      AppState.sessionToken,
      AppState.reportMode,
      targetColumn,
      targetValues,
      questionCodes,
      axisSpecs,
    );

    if (resp.warnings?.length) {
      resp.warnings.forEach(w => showToast(w, false));
    }

    addReportProjectPages(resp.pages);

    if (resp.pages.length > 0) {
      setReportMainMode("preview");
    }

  } catch (e) {
    _showError(e.message);
  } finally {
    setReportLoading(false);
    document.getElementById("report-generate-btn").disabled = false;
  }
}

function _showError(msg) {
  const el = document.getElementById("report-generate-error");
  if (el) { el.textContent = msg; el.style.display = ""; }
}

// ---------------------------------------------------------------------------
// chartSettings からグラフオプションを解決
// ---------------------------------------------------------------------------

function _resolveChartMode(cs, hasComparisonDatasets, axisCats) {
  const mode = cs?.chartMode ?? "auto";

  if (mode === "auto") {
    if (hasComparisonDatasets) return { indexAxis: "x", stacked: false, percentage: false, forceSmall: true, brandHbar: false, brandVbar: false };
    const isSingle = axisCats?.length === 1 && axisCats[0] === "全体";
    return { indexAxis: isSingle ? "y" : "x", stacked: false, percentage: false, forceSmall: false, brandHbar: false, brandVbar: false };
  }

  if (mode === "brand_hbar")         return { indexAxis: "x", stacked: false, percentage: false, forceSmall: false, brandHbar: true,  brandVbar: false };
  if (mode === "brand_vbar")         return { indexAxis: "y", stacked: false, percentage: false, forceSmall: false, brandHbar: false, brandVbar: true };
  if (mode === "brand_vbar_stacked") return { indexAxis: "y", stacked: true,  percentage: true,  forceSmall: false, brandHbar: false, brandVbar: true };
  if (mode === "small_multiples")    return { indexAxis: "x", stacked: false, percentage: false, forceSmall: true,  brandHbar: false, brandVbar: false };

  return {
    indexAxis: mode.includes("hbar") ? "y" : "x",
    stacked: mode.includes("stacked"),
    percentage: mode.includes("100"),
    forceSmall: false,
    brandHbar: false,
    brandVbar: false,
  };
}

// ---------------------------------------------------------------------------
// 色解決
// ---------------------------------------------------------------------------

const CHART_COLORS = [
  "#0071BC", "#DF0515", "#3DAA68", "#F5A623", "#9B59B6",
  "#1ABC9C", "#E67E22", "#E74C3C", "#2980B9", "#27AE60",
];

function _resolveColorsForPage(cs, labels) {
  const co = cs?.colorSettings ?? {};
  return labels.map((label, i) => {
    if (co.overriddenSeriesColors?.[label]) return co.overriddenSeriesColors[label];
    if (label === "その他") return "#aaaaaa";
    if (label === "全体" && labels.length > 1) return "#555555";
    const vm = (co.valueColorMapping ?? []).find(e => e.label === label);
    if (vm) return vm.color;
    return CHART_COLORS[i % CHART_COLORS.length];
  });
}

// ---------------------------------------------------------------------------
// ページ HTML 構築
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// データ変換ヘルパー
// ---------------------------------------------------------------------------

function _transposeData(rows, axisCats, axisTotals) {
  if (!rows?.length || !axisCats?.length) return { rows, axisCats, axisTotals };
  const newRows = axisCats.map((cat, colIdx) => {
    const counts = rows.map(r => r.counts?.[colIdx] ?? 0);
    const colTotal = axisTotals?.[colIdx] ?? 0;
    const percents = rows.map(r =>
      colTotal > 0 ? (r.counts?.[colIdx] ?? 0) / colTotal * 100 : (r.percents?.[colIdx] ?? 0)
    );
    return { label: cat, percents, counts };
  });
  const newAxisCats = rows.map(r => r.label);
  const newAxisTotals = rows.map(r => (r.counts ?? []).reduce((a, b) => a + b, 0));
  return { rows: newRows, axisCats: newAxisCats, axisTotals: newAxisTotals };
}

function _filterChoices(rows, cs) {
  if (!cs?.hiddenChoices?.length) return rows;
  return rows.filter(r => !cs.hiddenChoices.includes(r.label));
}

// ---------------------------------------------------------------------------
// ページ HTML 構築
// ---------------------------------------------------------------------------

function _buildPageElement(page, idSuffix, cs) {
  cs = cs ?? _defaultChartSettings();
  const bandClass = page.mode === "comparison" ? "report-band-comparison" : "report-band-single";
  const hasComparison = !!(page.comparison_datasets?.length);
  const opts = _resolveChartMode(cs, hasComparison, page.axis_categories);

  const isBrandChart = opts.brandHbar || opts.brandVbar;
  const isSmallMultiple = !isBrandChart && (opts.forceSmall || hasComparison);

  const title = cs.titleOverride ?? page.title;
  const subtitle = cs.showQuestionText
    ? (cs.questionTextOverride ?? page.question_text)
    : "";

  let targetBadge = "";
  if (page.mode === "single" && title.includes("｜")) {
    const targetName = title.split("｜")[0];
    targetBadge = `<div class="report-page-target-badge">${_esc(targetName)}</div>`;
  }

  // グラフサイズ
  const wStyle = [];
  if (cs.chartHeightPx)  wStyle.push(`height:${cs.chartHeightPx}px;flex:none;`);
  if (cs.chartWidthPx)   wStyle.push(`width:${cs.chartWidthPx}px;`);
  if (cs.chartMaxWidthPx) wStyle.push(`max-width:${cs.chartMaxWidthPx}px;`);
  const chartStyle = wStyle.length ? `style="${wStyle.join("")}"` : "";

  const wrap = document.createElement("div");
  wrap.className = "report-page";
  wrap.dataset.pageId = page.page_id;

  wrap.innerHTML = `
    <div class="${bandClass}">
      <div class="report-page-title">${_esc(title)}</div>
      ${subtitle ? `<div class="report-page-subtitle" style="font-size:${cs.subtitleFontSize ?? 8}px">${_esc(subtitle)}</div>` : ""}
      ${targetBadge}
    </div>
    <div class="report-page-body">
      <div class="report-page-export-row"></div>
      ${isBrandChart
        ? `<div class="report-chart-wrap" ${chartStyle}><canvas id="report-chart-${idSuffix}"></canvas></div>`
        : isSmallMultiple
          ? _buildSmallMultiplesHtml(page, idSuffix, chartStyle)
          : `<div class="report-chart-wrap" ${chartStyle}><canvas id="report-chart-${idSuffix}"></canvas></div>`}
      ${cs.showTable ? _buildTableHtml(page, cs) : ""}
      <div class="report-page-footer">
        ${_buildNCountHtml(page, isSmallMultiple)}
        <span class="report-axis-label">分析軸: ${_esc(page.axis_label)}</span>
      </div>
    </div>
  `;

  return wrap;
}

function _buildSmallMultiplesHtml(page, idSuffix, chartStyle) {
  return `<div class="report-small-multiples">` +
    page.comparison_datasets.map((ds, dsIdx) =>
      `<div class="report-small-multiple-item">
        <div class="report-small-multiple-title">${_esc(ds.target_value)}</div>
        <div class="report-small-multiple-chart" ${chartStyle}>
          <canvas id="report-chart-${idSuffix}-${dsIdx}"></canvas>
        </div>
      </div>`
    ).join("") +
    `</div>`;
}

function _buildTableHtml(page, cs) {
  cs = cs ?? _defaultChartSettings();
  const mode = cs.tableContentMode ?? "percent";
  const dec = cs.tableDecimalPlaces ?? 1;
  const fs = cs.tableFontSize ?? 9;
  const showRowTotal = cs.showTableRowTotal;
  const showColTotal = cs.showTableColTotal;

  // セル値を文字列化するヘルパー
  const cellStr = (pct, cnt) => {
    if (mode === "count")   return _esc(String(cnt ?? 0));
    if (mode === "both")    return `${pct.toFixed(dec)}%<br><small>${cnt ?? 0}</small>`;
    return `${pct.toFixed(dec)}%`;
  };

  // comparison_datasets がある場合（比較+軸モード）
  if (page.comparison_datasets?.length) {
    const ds0 = page.comparison_datasets[0];
    if (!ds0.rows?.length) return "";

    // 全データセットで共通の選択肢リストを取得（cs.hiddenChoices でフィルタ）
    const allRows = _filterChoices(ds0.rows, cs);
    if (!allRows.length) return "";

    const datasets = page.comparison_datasets;
    const targetLabels = datasets.map(ds => ds.target_value);

    // ヘッダー行：空 + target_value ラベル群 + (合計列ヘッダー)
    const headerCells = targetLabels.map(t => `<th>${_esc(t)}</th>`).join("") +
      (showRowTotal ? `<th class="report-table-total">合計</th>` : "");

    // データ行
    const dataRows = allRows.map((row) => {
      const cells = datasets.map((ds) => {
        const dsRow = ds.rows.find(r => r.label === row.label);
        const pct = dsRow?.percents?.[0] ?? 0;
        const cnt = dsRow?.counts?.[0] ?? 0;
        return `<td>${cellStr(pct, cnt)}</td>`;
      }).join("");
      // 合計列
      const rowTotalHtml = showRowTotal
        ? (() => {
            const totalCnt = datasets.reduce((sum, ds) => {
              const dsRow = ds.rows.find(r => r.label === row.label);
              return sum + (dsRow?.counts?.[0] ?? 0);
            }, 0);
            const totalN = datasets.reduce((sum, ds) => sum + (ds.axis_totals?.[0] ?? 0), 0);
            const totalPct = totalN > 0 ? totalCnt / totalN * 100 : 0;
            return `<td class="report-table-total">${cellStr(totalPct, totalCnt)}</td>`;
          })()
        : "";
      return `<tr><td>${_esc(row.label)}</td>${cells}${rowTotalHtml}</tr>`;
    });

    // 合計行
    const colTotalRow = showColTotal
      ? `<tr class="report-table-total-row"><td>合計</td>${datasets.map((ds) => {
          const totalCnt = ds.rows.reduce((s, r) => s + (r.counts?.[0] ?? 0), 0);
          const n = ds.axis_totals?.[0] ?? 0;
          const totalPct = n > 0 ? totalCnt / n * 100 : 0;
          return `<td class="report-table-total">${cellStr(totalPct, totalCnt)}</td>`;
        }).join("")}${showRowTotal ? `<td class="report-table-total">—</td>` : ""}</tr>`
      : "";

    return `
      <div class="report-table-wrap">
        <table class="report-table" style="font-size:${fs}px">
          <thead><tr><th></th>${headerCells}</tr></thead>
          <tbody>${dataRows.join("")}${colTotalRow}</tbody>
        </table>
      </div>`;
  }

  // 通常ページ（page.rows が存在する場合）
  let { rows, axisCats, axisTotals } = {
    rows: page.rows ?? [],
    axisCats: page.axis_categories ?? [],
    axisTotals: page.axis_totals ?? [],
  };

  // 行列入れ替え
  if (cs.transpose && rows.length && axisCats.length) {
    ({ rows, axisCats, axisTotals } = _transposeData(rows, axisCats, axisTotals));
  }

  // 選択肢フィルタ
  rows = _filterChoices(rows, cs);

  if (!axisCats.length || !rows.length) return "";

  const headerCells = axisCats.map(c => `<th>${_esc(c)}</th>`).join("") +
    (showRowTotal ? `<th class="report-table-total">合計</th>` : "");

  const dataRows = rows.map(r => {
    const cells = r.percents.map((p, i) =>
      `<td>${cellStr(p, r.counts?.[i])}</td>`
    ).join("");
    // 合計列
    const rowTotalHtml = showRowTotal
      ? (() => {
          const totalCnt = (r.counts ?? []).reduce((a, b) => a + b, 0);
          const totalN = (axisTotals ?? []).reduce((a, b) => a + b, 0);
          const totalPct = totalN > 0 ? totalCnt / totalN * 100 : 0;
          return `<td class="report-table-total">${cellStr(totalPct, totalCnt)}</td>`;
        })()
      : "";
    return `<tr><td>${_esc(r.label)}</td>${cells}${rowTotalHtml}</tr>`;
  });

  // 合計行
  const colTotalRow = showColTotal
    ? `<tr class="report-table-total-row"><td>合計</td>${axisCats.map((_, i) => {
        const cnt = rows.reduce((s, r) => s + (r.counts?.[i] ?? 0), 0);
        const n = axisTotals?.[i] ?? 0;
        const pct = n > 0 ? cnt / n * 100 : 0;
        return `<td class="report-table-total">${cellStr(pct, cnt)}</td>`;
      }).join("")}${showRowTotal ? `<td class="report-table-total">—</td>` : ""}</tr>`
    : "";

  return `
    <div class="report-table-wrap">
      <table class="report-table" style="font-size:${fs}px">
        <thead><tr><th></th>${headerCells}</tr></thead>
        <tbody>${dataRows.join("")}${colTotalRow}</tbody>
      </table>
    </div>`;
}

function _buildNCountHtml(page, isSmallMultiple) {
  if (isSmallMultiple && page.comparison_datasets?.length) {
    const ns = page.comparison_datasets.map(ds =>
      `${_esc(ds.target_value)}: n=${ds.axis_totals.reduce((a, b) => a + b, 0)}`
    ).join("  /  ");
    return `<span class="report-n-count">${ns}</span>`;
  }
  const totals = page.axis_totals ?? [];
  if (!totals.length) return "";
  const cats = page.axis_categories ?? [];
  const parts = totals.map((n, i) => {
    const label = cats[i] ?? "";
    return label === "全体" ? `n=${n}` : `${_esc(label)}: n=${n}`;
  }).join("  /  ");
  return `<span class="report-n-count">${parts}</span>`;
}

// ---------------------------------------------------------------------------
// Chart.js レンダリング
// ---------------------------------------------------------------------------

function _renderPageChart(page, idSuffix, cs) {
  cs = cs ?? _defaultChartSettings();
  const hasComparison = !!(page.comparison_datasets?.length);
  const opts = _resolveChartMode(cs, hasComparison, page.axis_categories);

  if (opts.brandHbar && hasComparison) {
    const canvas = document.getElementById(`report-chart-${idSuffix}`);
    if (canvas) _buildBrandHbarChart(canvas, String(idSuffix), page.comparison_datasets, cs);
    return;
  }

  if (opts.brandVbar && hasComparison) {
    const canvas = document.getElementById(`report-chart-${idSuffix}`);
    if (canvas) _buildBrandVbarChart(canvas, String(idSuffix), page.comparison_datasets, cs, opts.stacked, opts.percentage);
    return;
  }

  if (opts.forceSmall || (hasComparison && !opts.brandHbar && !opts.brandVbar)) {
    page.comparison_datasets.forEach((ds, dsIdx) => {
      const canvas = document.getElementById(`report-chart-${idSuffix}-${dsIdx}`);
      if (!canvas) return;
      _buildBarChart(canvas, `${idSuffix}-${dsIdx}`, ds.rows, ds.axis_categories, ds.axis_totals, cs, opts);
    });
  } else {
    const canvas = document.getElementById(`report-chart-${idSuffix}`);
    if (!canvas) return;
    _buildBarChart(canvas, String(idSuffix), page.rows, page.axis_categories, page.axis_totals, cs, opts);
  }
}

function _buildBarChart(canvas, chartId, rows, axisCats, axisTotals, cs, opts) {
  if (!rows?.length || !axisCats?.length) return;
  cs = cs ?? _defaultChartSettings();

  // 選択肢フィルタ
  rows = _filterChoices(rows, cs);
  if (!rows.length) return;

  // 行列入れ替え
  if (cs.transpose) {
    ({ rows, axisCats, axisTotals } = _transposeData(rows, axisCats, axisTotals));
  }

  const labels = rows.map(r => r.label);
  const colors = _resolveColorsForPage(cs, axisCats);
  const isStacked = opts?.stacked ?? false;
  const isPercentage = opts?.percentage ?? false;
  const indexAxis = opts?.indexAxis ?? (axisCats.length === 1 && axisCats[0] === "全体" ? "y" : "x");
  const isSingleCat = axisCats.length === 1;

  const datasets = axisCats.map((cat, i) => ({
    label: cat,
    data: rows.map(r => r.percents[i] ?? 0),
    backgroundColor: colors[i],
    ...(cs.barThickness != null ? { barThickness: cs.barThickness } : {}),
  }));

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis,
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: cs.categoryPercentage ?? 0.8,
      barPercentage: cs.barPercentage ?? 0.9,
      plugins: {
        legend: {
          display: (cs.showLegend ?? true) && !isSingleCat,
          position: cs.legendPosition ?? "bottom",
          labels: { boxWidth: 14, font: { size: cs.legendFontSize ?? 11 } },
        },
        datalabels: {
          display: (cs.showLabels ?? true)
            ? (ctx) => ctx.dataset.data[ctx.dataIndex] >= (cs.labelMinPercent ?? 2)
            : false,
          color: "#fff",
          font: { size: cs.labelFontSize ?? 10, weight: "bold" },
          formatter: (v) => `${v.toFixed(cs.labelDecimalPlaces ?? 1)}%`,
          anchor: cs.labelAnchor ?? "center",
          align: cs.labelAlign ?? "center",
        },
      },
      scales: {
        x: {
          stacked: isStacked,
          beginAtZero: true,
          max: (indexAxis === "y" && !isStacked) ? 100 : (isPercentage ? 100 : undefined),
          ticks: {
            font: { size: cs.axisFontSize ?? 10 },
            callback: indexAxis === "y" ? (v) => `${v}%` : undefined,
          },
        },
        y: {
          stacked: isStacked,
          ticks: { font: { size: cs.axisFontSize ?? 10 } },
          max: (indexAxis === "x" && !isStacked) ? 100 : (isPercentage && indexAxis === "x" ? 100 : undefined),
          ...(indexAxis === "x" ? { beginAtZero: true } : {}),
        },
      },
    },
  });

  _charts.set(chartId, chart);
}

function _buildBrandHbarChart(canvas, chartId, comparisonDatasets, cs) {
  if (!comparisonDatasets?.length) return;
  cs = cs ?? _defaultChartSettings();

  // 選択肢フィルタ（comparison_datasetsの最初のrowセット基準）
  const filteredDs = comparisonDatasets.map(ds => ({
    ...ds,
    rows: _filterChoices(ds.rows, cs),
  }));
  if (!filteredDs[0]?.rows?.length) return;

  const brandLabels = filteredDs.map(ds => ds.target_value);
  const axisCats = filteredDs[0].axis_categories;
  const colors = _resolveColorsForPage(cs, axisCats);

  const datasets = axisCats.map((cat, catIdx) => ({
    label: cat,
    data: filteredDs.map(ds => ds.rows[0]?.percents[catIdx] ?? 0),
    backgroundColor: colors[catIdx],
    ...(cs.barThickness != null ? { barThickness: cs.barThickness } : {}),
  }));

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: brandLabels, datasets },
    options: {
      indexAxis: "x",
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: cs.categoryPercentage ?? 0.8,
      barPercentage: cs.barPercentage ?? 0.9,
      plugins: {
        legend: { display: cs.showLegend ?? true, position: cs.legendPosition ?? "bottom", labels: { boxWidth: 14, font: { size: cs.legendFontSize ?? 11 } } },
        datalabels: {
          display: (cs.showLabels ?? true)
            ? (ctx) => ctx.dataset.data[ctx.dataIndex] >= (cs.labelMinPercent ?? 2)
            : false,
          color: "#fff",
          font: { size: cs.labelFontSize ?? 10, weight: "bold" },
          formatter: (v) => `${v.toFixed(cs.labelDecimalPlaces ?? 1)}%`,
          anchor: cs.labelAnchor ?? "center",
          align: cs.labelAlign ?? "center",
        },
      },
      scales: {
        x: { ticks: { font: { size: cs.axisFontSize ?? 10 } } },
        y: { beginAtZero: true, max: 100, ticks: { font: { size: cs.axisFontSize ?? 10 }, callback: (v) => `${v}%` } },
      },
    },
  });

  _charts.set(chartId, chart);
}

function _buildBrandVbarChart(canvas, chartId, comparisonDatasets, cs, stacked, percentage) {
  if (!comparisonDatasets?.length) return;
  cs = cs ?? _defaultChartSettings();
  stacked = stacked ?? false;
  percentage = percentage ?? false;

  const filteredDs = comparisonDatasets.map(ds => ({
    ...ds,
    rows: _filterChoices(ds.rows, cs),
  }));
  if (!filteredDs[0]?.rows?.length) return;

  const brandLabels = filteredDs.map(ds => ds.target_value);
  const axisCats = filteredDs[0].axis_categories;
  const colors = _resolveColorsForPage(cs, axisCats);

  const datasets = axisCats.map((cat, catIdx) => ({
    label: cat,
    data: filteredDs.map(ds => ds.rows[0]?.percents[catIdx] ?? 0),
    backgroundColor: colors[catIdx],
    ...(cs.barThickness != null ? { barThickness: cs.barThickness } : {}),
  }));

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: brandLabels, datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: cs.categoryPercentage ?? 0.8,
      barPercentage: cs.barPercentage ?? 0.9,
      plugins: {
        legend: { display: cs.showLegend ?? true, position: cs.legendPosition ?? "bottom", labels: { boxWidth: 14, font: { size: cs.legendFontSize ?? 11 } } },
        datalabels: {
          display: (cs.showLabels ?? true)
            ? (ctx) => ctx.dataset.data[ctx.dataIndex] >= (cs.labelMinPercent ?? 2)
            : false,
          color: "#fff",
          font: { size: cs.labelFontSize ?? 10, weight: "bold" },
          formatter: (v) => `${v.toFixed(cs.labelDecimalPlaces ?? 1)}%`,
          anchor: cs.labelAnchor ?? "center",
          align: cs.labelAlign ?? "center",
        },
      },
      scales: {
        x: {
          stacked,
          beginAtZero: true,
          max: percentage ? 100 : undefined,
          ticks: { font: { size: cs.axisFontSize ?? 10 }, callback: (v) => `${v}%` },
        },
        y: {
          stacked,
          ticks: { font: { size: cs.axisFontSize ?? 10 } },
        },
      },
    },
  });

  _charts.set(chartId, chart);
}

// ---------------------------------------------------------------------------
// PNG 出力
// ---------------------------------------------------------------------------

async function _exportActivePng() {
  const canvas = document.getElementById("report-preview-canvas");
  if (!canvas) return;
  const cvs = canvas.querySelectorAll("canvas");
  if (!cvs.length) { showToast("グラフがありません。", true); return; }
  const activePage = AppState.reportProject.pages.find(p => p.pageId === AppState.reportProject.activePageId);
  const baseName = activePage
    ? _displayTitle(activePage).replace(/[｜：\/\\]/g, "_")
    : "report_page";
  cvs.forEach((cv, i) => {
    const url = cv.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}${cvs.length > 1 ? `_${i + 1}` : ""}.png`;
    a.click();
  });
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// DOM 準備後に初期化
// ---------------------------------------------------------------------------

function _domReady() {
  initReport();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _domReady);
} else {
  _domReady();
}

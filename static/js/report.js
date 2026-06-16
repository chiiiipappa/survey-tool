/**
 * レポート生成パネル（Phase 4: グラフ調整・カラー連携）
 */
import {
  AppState,
  setReportProject, addReportProjectPages, addChartResultsAsReportPages,
  updateReportProjectPage, duplicateReportProjectPage, removeReportProjectPage,
  setActiveReportPageId, setReportMainMode,
  reorderReportPage,
  getSplitGroupPages, reflowSplitPages,
  moveSplitGraphUp, moveSplitGraphDown, moveSplitGraphToAdjacentPage,
  toggleSplitGraphVisibility,
} from "./state.js";
import { showToast } from "./app.js";
import { exportReportPptx } from "./api.js";

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
    // 行列入れ替え（STEP3から継承、STEP4では変更不可）
    transpose: false,
    // 選択肢並び順
    sortOrder: "original",  // "original" | "asc" | "desc"
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

// 新フォーマット (chartConfig + layoutConfig) と旧フォーマット (chartSettings) 両対応
function _getEffectiveCS(page) {
  if (page?.chartConfig && page?.layoutConfig) {
    const merged = { ...page.chartConfig };
    for (const [k, v] of Object.entries(page.layoutConfig)) {
      if (v !== null) merged[k] = v;
    }
    return merged;
  }
  return { ..._defaultChartSettings(), ...(page?.chartSettings ?? {}) };
}

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

export function initReport() {
  document.addEventListener("survey:statechange", _onStateChange);
  _bindEvents();
  _bindEditPanelEvents();
}

export function resetReportUI() {
  _charts.forEach(c => c.destroy());
  _charts.clear();
  _lastPreviewPageId = null;
  _lastPreviewMode = null;

  const pageItems = document.getElementById("report-page-items");
  if (pageItems) pageItems.innerHTML = "";
  const chartList = document.getElementById("report-chart-result-list");
  if (chartList) chartList.innerHTML = "";
  const canvas = document.getElementById("report-preview-canvas");
  if (canvas) canvas.innerHTML = "";
  const previewPanel = document.getElementById("report-preview-panel");
  if (previewPanel) previewPanel.style.display = "none";
  const genError = document.getElementById("report-generate-error");
  if (genError) genError.style.display = "none";
}

function _bindEvents() {
  document.getElementById("report-generate-btn")?.addEventListener("click", _onGenerate);

  document.getElementById("report-cr-select-all-btn")?.addEventListener("click", () => {
    document.querySelectorAll("#report-chart-result-list input[type='checkbox']")
      .forEach(cb => { cb.checked = true; });
  });
  document.getElementById("report-cr-select-none-btn")?.addEventListener("click", () => {
    document.querySelectorAll("#report-chart-result-list input[type='checkbox']")
      .forEach(cb => { cb.checked = false; });
  });

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
  document.getElementById("report-export-pptx-btn")?.addEventListener("click", async () => {
    const pages = AppState.reportProject?.pages ?? [];
    if (!pages.length) { showToast("レポートページがありません。", true); return; }
    try {
      const warning = await exportReportPptx(pages, AppState.chartResults ?? []);
      if (warning) showToast(`⚠️ PPTX: ${warning}`, true);
    } catch (e) {
      showToast(e.message, true);
    }
  });

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

  // 選択肢並び順
  document.getElementById("edit-sort-order")?.addEventListener("change", (e) => {
    _patchChartSettings({ sortOrder: e.target.value });
  });

  // 分割グラフ: 列数（旧 UI、現在は非表示だが後方互換のため残す）
  document.getElementById("edit-split-cols")?.addEventListener("change", (e) => {
    const v = e.target.value;
    _patchChartSettings({ splitColumns: v ? parseInt(v, 10) : null });
  });

  // 分割グラフ: 自動再配置ボタン
  document.getElementById("edit-split-reflow-btn")?.addEventListener("click", () => {
    const activePageId = AppState.reportProject.activePageId;
    const page = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === activePageId);
    if (!page) return;
    const chartResultId = page.aggregationConfig?.chartResultId ?? page.chartResultId;
    if (!chartResultId) return;
    const ipp    = parseInt(document.getElementById("edit-split-ipp")?.value, 10) || null;
    const layout = document.getElementById("edit-split-layout")?.value ?? "auto";
    // 現在非表示の index を収集（どのページにも含まれない index）
    const cr = AppState.chartResults.find(r => r.id === chartResultId);
    const splitMode = page.chartConfig?.splitMode ?? "normal";
    let totalCount = 0;
    if (splitMode === "by_axis")       totalCount = (cr?.axis_categories ?? []).length;
    else if (splitMode === "by_comparison") totalCount = (cr?.rows ?? []).length;
    const groupPages  = getSplitGroupPages(chartResultId);
    const visibleSet  = new Set(groupPages.flatMap(p => p.chartConfig?.splitDatasetIndices ?? []));
    const hiddenIndices = Array.from({ length: totalCount }, (_, i) => i).filter(i => !visibleSet.has(i));
    reflowSplitPages(chartResultId, ipp, layout, hiddenIndices);
  });
}

function _onStateChange() {
  if (AppState.activePanel !== "report") return;

  _renderChartResultList();
  _renderPageList();

  const activePageId = AppState.reportProject.activePageId;
  const isPreview = AppState.reportMainMode === "preview" && activePageId;
  document.getElementById("report-settings-panel").style.display = isPreview ? "none" : "";
  document.getElementById("report-preview-panel").style.display = isPreview ? "" : "none";

  if (isPreview && (activePageId !== _lastPreviewPageId || AppState.reportMainMode !== _lastPreviewMode)) {
    _lastPreviewPageId = activePageId;
    _lastPreviewMode = AppState.reportMainMode;
    const activePage = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === activePageId);
    if (activePage && (activePage.funnelData || _getPageDisplayData(activePage))) {
      _renderPreview(activePage);
    }
  }
  if (!isPreview) {
    _lastPreviewPageId = null;
    _lastPreviewMode = null;
  }

  if (isPreview) {
    const activePage = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === activePageId);
    if (activePage) _renderEditPanel(activePage);
  }
}

// ---------------------------------------------------------------------------
// 集計リスト描画（STEP3 から追加された ChartResult を表示）
// ---------------------------------------------------------------------------

function _renderChartResultList() {
  const listEl = document.getElementById("report-chart-result-list");
  const emptyEl = document.getElementById("report-chart-result-empty");
  if (!listEl) return;

  const results = AppState.chartResults ?? [];
  if (results.length === 0) {
    listEl.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "";
    return;
  }

  if (emptyEl) emptyEl.style.display = "none";
  listEl.innerHTML = results.map(cr => {
    const label = cr.target_filter_values?.length
      ? `${_esc(cr.title)}（${_esc(cr.target_filter_values.join(", "))}）`
      : _esc(cr.title);
    return `<label>
      <input type="checkbox" name="report-cr" value="${_esc(cr.id)}" checked>
      <span title="${_esc(cr.id)}">${label}</span>
    </label>`;
  }).join("");
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
      ページがありません。<br>STEP3 で集計を追加してください。
    </li>`;
    return;
  }
  ol.innerHTML = pages.map((p, i) => {
    const pid = p.id ?? p.pageId;
    return `<li class="report-page-item${pid === activePageId ? " active" : ""}" data-page-id="${_esc(pid)}">
      <span class="report-page-item-num">${i + 1}</span>
      <span class="report-page-item-title">${_esc(_displayTitle(p))}</span>
      <span class="report-page-item-actions">
        <button class="report-page-order-btn" data-dir="up" title="上へ">↑</button>
        <button class="report-page-order-btn" data-dir="down" title="下へ">↓</button>
      </span>
    </li>`;
  }).join("");
  ol.querySelectorAll(".report-page-item[data-page-id]").forEach(li => {
    li.addEventListener("click", (e) => {
      if (e.target.closest(".report-page-order-btn")) return;
      setActiveReportPageId(li.dataset.pageId);
      setReportMainMode("preview");
    });
    li.querySelectorAll(".report-page-order-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        reorderReportPage(li.dataset.pageId, btn.dataset.dir);
      });
    });
  });
}

function _displayTitle(page) {
  return page.layoutConfig?.titleOverride
    ?? page.chartConfig?.titleOverride
    ?? page.chartSettings?.titleOverride
    ?? page.title
    ?? "";
}

// ---------------------------------------------------------------------------
// 後方互換: generatedData（旧形式）と chartResultId（新形式）を統一取得
// ---------------------------------------------------------------------------

function _getPageDisplayData(page) {
  const crId = page.aggregationConfig?.chartResultId ?? page.chartResultId;
  if (crId) {
    return (AppState.chartResults ?? []).find(r => r.id === crId) ?? null;
  }
  return page.generatedData ?? null;
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
  const cs = _getEffectiveCS(page);

  if (page.funnelData) {
    const el = _buildFunnelPage(page, "preview", cs);
    canvas.appendChild(el);
    _renderFunnelChart(page, "preview", cs);
    return;
  }

  const displayData = _getPageDisplayData(page);
  if (!displayData) {
    canvas.innerHTML = `<div style="padding:20px;color:var(--color-text-muted)">集計データが見つかりません</div>`;
    return;
  }

  const el = _buildPageElement(displayData, "preview", cs);
  canvas.appendChild(el);
  _renderPageChart(displayData, "preview", cs);
}

// ---------------------------------------------------------------------------
// 編集パネル描画・更新
// ---------------------------------------------------------------------------

function _renderEditPanel(page) {
  const cs = _getEffectiveCS(page);

  const displayData = _getPageDisplayData(page);

  // タイトル
  const titleInput = document.getElementById("edit-title-input");
  if (titleInput && titleInput !== document.activeElement) {
    titleInput.value = cs.titleOverride ?? "";
    titleInput.placeholder = displayData?.title ?? "自動生成タイトル";
  }

  // 設問文
  const subtitleInput = document.getElementById("edit-subtitle-input");
  if (subtitleInput && subtitleInput !== document.activeElement) {
    subtitleInput.value = cs.questionTextOverride ?? "";
    subtitleInput.placeholder = displayData?.question_text ?? "設問文（自動取得）";
  }
  const showQtEl = document.getElementById("edit-show-question-text");
  if (showQtEl) showQtEl.checked = cs.showQuestionText;

  // グラフ種別（読み取り専用 — STEP3から継承）
  const grid = document.getElementById("edit-chart-mode-grid");
  if (grid) {
    const modeMeta = CHART_MODES.find(m => m.id === cs.chartMode) ?? CHART_MODES[0];
    grid.innerHTML = `<span class="report-chart-mode-readonly">${modeMeta.icon} ${_esc(modeMeta.label)}</span>`;
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

  // 選択肢並び順
  const sortEl = document.getElementById("edit-sort-order");
  if (sortEl) sortEl.value = cs.sortOrder ?? "original";

  // 選択肢フィルタ
  _renderChoiceFilterList(page, cs);

  // 分割グラフ設定セクション (旧: edit-split-section は非表示、新: edit-split-graph-list-section を使用)
  const splitSection = document.getElementById("edit-split-section");
  if (splitSection) splitSection.style.display = "none";

  const isSplit = (cs.splitMode ?? "normal") !== "normal";
  const splitListSection = document.getElementById("edit-split-graph-list-section");
  if (splitListSection) {
    splitListSection.style.display = isSplit ? "" : "none";
    if (isSplit) {
      const ippEl = document.getElementById("edit-split-ipp");
      if (ippEl) ippEl.value = String(cs.itemsPerPage ?? "");
      const layoutEl = document.getElementById("edit-split-layout");
      if (layoutEl) layoutEl.value = cs.pageLayout ?? "auto";
      _renderSplitGraphList(page);
    }
  }

  // カラーリスト
  _renderColorList(page, cs);
}

function _renderSplitGraphList(page) {
  const container = document.getElementById("edit-split-graph-list");
  if (!container) return;

  const chartResultId = page.aggregationConfig?.chartResultId ?? page.chartResultId;
  const cr = AppState.chartResults.find(r => r.id === chartResultId);
  if (!cr) { container.innerHTML = ""; return; }

  const splitMode  = page.chartConfig?.splitMode ?? "normal";
  const groupPages = getSplitGroupPages(chartResultId);

  // 全仮想データセットのラベルを取得
  const allLabels = splitMode === "by_axis"
    ? (cr.axis_categories ?? [])
    : (cr.rows ?? []).map(r => r.row_label ?? r.label ?? "");

  // dsIndex → {pageId, pageNo, posInPage, totalInPage} のマップを構築
  const dsInfoMap = new Map();
  groupPages.forEach((p, pgIdx) => {
    const indices = p.chartConfig?.splitDatasetIndices ?? [];
    indices.forEach((dsIdx, pos) => {
      dsInfoMap.set(dsIdx, {
        pageId:      p.id ?? p.pageId,
        pageNo:      pgIdx + 1,
        posInPage:   pos,
        totalInPage: indices.length,
        pgIdx,
      });
    });
  });

  const totalPages = groupPages.length;

  const html = allLabels.map((label, dsIdx) => {
    const info    = dsInfoMap.get(dsIdx);
    const visible = !!info;
    const pageNo  = info?.pageNo ?? "-";
    const isFirst = info?.posInPage === 0;
    const isLast  = info != null && info.posInPage === info.totalInPage - 1;
    const isFirstPage = info?.pgIdx === 0;
    const isLastPage  = info != null && info.pgIdx === totalPages - 1;
    const safeLbl = label.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    return `<div class="split-graph-item${visible ? "" : " split-graph-item--hidden"}" data-ds-index="${dsIdx}">
      <span class="split-graph-page-badge">${visible ? `P${pageNo}` : "非"}</span>
      <span class="split-graph-title" title="${safeLbl}">${safeLbl}</span>
      <div class="split-graph-actions">
        <button class="split-graph-btn" data-action="up"   data-ds="${dsIdx}" ${(!visible || isFirst)     ? "disabled" : ""} title="上へ">↑</button>
        <button class="split-graph-btn" data-action="down" data-ds="${dsIdx}" ${(!visible || isLast)      ? "disabled" : ""} title="下へ">↓</button>
        <button class="split-graph-btn" data-action="prev" data-ds="${dsIdx}" ${(!visible || isFirstPage) ? "disabled" : ""} title="前ページへ">«</button>
        <button class="split-graph-btn" data-action="next" data-ds="${dsIdx}" ${(!visible || isLastPage)  ? "disabled" : ""} title="次ページへ">»</button>
        <label class="split-graph-vis-label">
          <input type="checkbox" class="split-graph-vis" data-ds="${dsIdx}" ${visible ? "checked" : ""}> 表示
        </label>
      </div>
    </div>`;
  }).join("");

  container.innerHTML = html;

  // 移動ボタンのイベントハンドラ
  container.querySelectorAll(".split-graph-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const ds  = parseInt(btn.dataset.ds, 10);
      const act = btn.dataset.action;
      // このグラフが現在どのページにいるかを再確認
      const currentGroupPages = getSplitGroupPages(chartResultId);
      const ownerPage = currentGroupPages.find(p =>
        (p.chartConfig?.splitDatasetIndices ?? []).includes(ds)
      );
      if (!ownerPage && act !== "vis") return;
      const ownerPageId = ownerPage ? (ownerPage.id ?? ownerPage.pageId) : null;
      if      (act === "up")   moveSplitGraphUp(ds, ownerPageId);
      else if (act === "down") moveSplitGraphDown(ds, ownerPageId);
      else if (act === "prev") moveSplitGraphToAdjacentPage(ds, ownerPageId, -1);
      else if (act === "next") moveSplitGraphToAdjacentPage(ds, ownerPageId, +1);
    });
  });

  // 表示/非表示 checkbox のイベントハンドラ
  container.querySelectorAll(".split-graph-vis").forEach(cb => {
    cb.addEventListener("change", () => {
      toggleSplitGraphVisibility(parseInt(cb.dataset.ds, 10), chartResultId);
    });
  });
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
      const page2 = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === pageId);
      const cs2 = _getEffectiveCS(page2);
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

  const data = _getPageDisplayData(page);
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

  // 手動並び替え順が設定済みなら優先。APIに存在しないラベルは除去、未収録は末尾追加。
  const savedOrder = cs.rowChoiceOrder;
  const displayLabels = savedOrder?.length
    ? [
        ...savedOrder.filter(l => allLabels.includes(l)),
        ...allLabels.filter(l => !savedOrder.includes(l)),
      ]
    : [...allLabels];
  const hasManualOrder = !!(savedOrder?.length);

  const hidden = new Set(cs.hiddenChoices ?? []);
  listEl.innerHTML =
    `<div class="report-choice-order-header">
      <button id="edit-choice-order-reset" class="report-choice-order-reset-btn"
        ${hasManualOrder ? "" : "disabled"} title="STEP1の選択肢順に戻す">調査票の順番に戻す</button>
    </div>` +
    displayLabels.map((label, idx) =>
      `<div class="report-choice-filter-row" data-label="${_esc(label)}">
        <span class="report-choice-order-btns">
          <button class="edit-choice-up report-choice-order-btn" data-idx="${idx}"
            ${idx === 0 ? "disabled" : ""} title="上へ">↑</button>
          <button class="edit-choice-down report-choice-order-btn" data-idx="${idx}"
            ${idx === displayLabels.length - 1 ? "disabled" : ""} title="下へ">↓</button>
        </span>
        <label class="report-choice-filter-label">
          <input type="checkbox" class="edit-choice-cb" data-label="${_esc(label)}"
            ${hidden.has(label) ? "" : "checked"}>
          <span style="font-size:.78rem">${_esc(label)}</span>
        </label>
      </div>`
    ).join("");

  // チェックボックス変更
  listEl.querySelectorAll(".edit-choice-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const allCbs = [...listEl.querySelectorAll(".edit-choice-cb")];
      const newHidden = allCbs.filter(c => !c.checked).map(c => c.dataset.label);
      _patchChartSettings({ hiddenChoices: newHidden });
    });
  });

  // 上ボタン
  listEl.querySelectorAll(".edit-choice-up").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (idx <= 0) return;
      const newOrder = [...displayLabels];
      [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
      _patchChartSettings({ rowChoiceOrder: newOrder });
    });
  });

  // 下ボタン
  listEl.querySelectorAll(".edit-choice-down").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (idx >= displayLabels.length - 1) return;
      const newOrder = [...displayLabels];
      [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
      _patchChartSettings({ rowChoiceOrder: newOrder });
    });
  });

  // リセットボタン（調査票の順番に戻す）
  listEl.querySelector("#edit-choice-order-reset")?.addEventListener("click", () => {
    _patchChartSettings({ rowChoiceOrder: null });
  });
}

function _getPageColorLabels(page) {
  const data = _getPageDisplayData(page);
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
  const page = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === pageId);
  if (!page) return;
  if (page.layoutConfig) {
    updateReportProjectPage(pageId, { layoutConfig: { ...page.layoutConfig, ...patch } });
  } else {
    const next = { ..._defaultChartSettings(), ...(page.chartSettings ?? {}), ...patch };
    updateReportProjectPage(pageId, { chartSettings: next });
  }
  _lastPreviewPageId = null;  // 強制再描画
}

function _syncColorsFromStep3(pageId) {
  const page = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === pageId);
  if (!page) return;
  const qCode = page.aggregationConfig?.questionCode ?? page.questionCode;
  const viewId = AppState.step3ActiveViewId;
  const view = AppState.step3Views[viewId];
  const step3QS = view?.questionSettings?.[qCode]
                ?? AppState.step3QuestionSettings?.[qCode]
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
// レポートページ追加（選択した ChartResult から）
// ---------------------------------------------------------------------------

function _showError(msg) {
  const el = document.getElementById("report-generate-error");
  if (el) { el.textContent = msg; el.style.display = ""; }
}

function _hideError() {
  const el = document.getElementById("report-generate-error");
  if (el) el.style.display = "none";
}

function _onGenerate() {
  _hideError();

  const selectedIds = [...document.querySelectorAll("#report-chart-result-list input[name='report-cr']:checked")]
    .map(cb => cb.value);

  if (selectedIds.length === 0) {
    _showError("集計を1つ以上選択してください。");
    return;
  }

  const selected = (AppState.chartResults ?? []).filter(cr => selectedIds.includes(cr.id));
  if (selected.length === 0) {
    _showError("選択した集計が見つかりません。");
    return;
  }

  addChartResultsAsReportPages(selected);
  setReportMainMode("preview");
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

// rowChoiceOrder（手動並び替え）を適用する。order外のラベルは末尾に追加。
function _applyRowChoiceOrder(rows, order) {
  if (!order?.length) return rows;
  const mapped = new Map(rows.map(r => [r.label, r]));
  const ordered = order.filter(lbl => mapped.has(lbl)).map(lbl => mapped.get(lbl));
  const remaining = rows.filter(r => !order.includes(r.label));
  return [...ordered, ...remaining];
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
  const splitMode = cs.splitMode ?? "normal";
  const isSplitMode = splitMode !== "normal" && !isBrandChart;
  const isSmallMultiple = !isBrandChart && (opts.forceSmall || hasComparison || isSplitMode);

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
          ? _buildSmallMultiplesHtml(page, idSuffix, chartStyle, cs)
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

// ---------------------------------------------------------------------------
// 分割グラフ (splitMode) ヘルパー
// ---------------------------------------------------------------------------

/** by_axis: axis_categories ごとに仮想サブデータセットを生成 */
function _buildSplitByAxisDatasetsR4(page) {
  const axisCategories = page.axis_categories ?? [];
  const axisTotals     = page.axis_totals ?? [];
  const rows           = page.rows ?? [];
  const choiceLabels   = rows.map(r => r.label);
  return axisCategories.map((cat, ci) => ({
    target_value:    cat,
    rows: [{ label: cat, percents: rows.map(r => r.percents[ci] ?? 0), counts: rows.map(r => (r.counts ?? [])[ci] ?? 0) }],
    axis_categories: choiceLabels,
    axis_totals:     [axisTotals[ci] ?? 0],
  }));
}

/** by_comparison: rows ごとに仮想サブデータセットを生成 */
function _buildSplitByComparisonDatasetsR4(page) {
  const axisCategories = page.axis_categories ?? [];
  const axisTotals     = page.axis_totals ?? [];
  const rows           = page.rows ?? [];
  return rows.map(row => ({
    target_value:    row.label,
    rows: [{ label: row.label, percents: axisCategories.map((_, ci) => row.percents[ci] ?? 0), counts: axisCategories.map((_, ci) => (row.counts ?? [])[ci] ?? 0) }],
    axis_categories: [...axisCategories],
    axis_totals:     [...axisTotals],
  }));
}

/** 全サブデータセットの percents 最大値を 10 刻みで切り上げて返す */
function _calcSharedMaxR4(datasets) {
  let max = 0;
  datasets.forEach(ds => ds.rows.forEach(r => r.percents.forEach(v => { if (v > max) max = v; })));
  return Math.min(100, Math.ceil(max / 10) * 10) || 100;
}

/** 分割サブチャートの Chart.js インスタンスを生成して返す */
function _buildSplitSubChartR4(canvas, chartId, ds, cs, color, sharedMax) {
  if (!canvas) return;
  const row    = ds.rows?.[0];
  const labels = ds.axis_categories ?? [];
  if (!labels.length || !row) return;

  const isH      = (cs.chartMode === "hbar") || false;
  const showLabel = cs.showLabels ?? true;
  const dec       = cs.labelDecimalPlaces ?? 1;
  const minPct    = cs.labelMinPercent ?? 2;
  const axisFs    = cs.axisFontSize ?? 10;

  const dataset = {
    label:           row.label,
    data:            row.percents,
    backgroundColor: color,
  };
  if (cs.barThickness != null) dataset.barThickness = cs.barThickness;

  const maxVal = sharedMax ?? 100;
  const tickCb = v => `${v}%`;

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [dataset] },
    options: {
      indexAxis:           isH ? "y" : "x",
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: showLabel ? ctx => ctx.dataset.data[ctx.dataIndex] >= minPct : false,
          color: "#fff",
          font: { size: cs.labelFontSize ?? 10, weight: "bold" },
          formatter: v => `${v.toFixed(dec)}%`,
          anchor: cs.labelAnchor ?? "center",
          align: cs.labelAlign ?? "center",
        },
      },
      scales: isH
        ? { x: { beginAtZero: true, max: maxVal, ticks: { font: { size: axisFs }, callback: tickCb } }, y: { ticks: { font: { size: axisFs } } } }
        : { x: { ticks: { font: { size: axisFs }, maxRotation: 45 } }, y: { beginAtZero: true, max: maxVal, ticks: { font: { size: axisFs }, callback: tickCb } } },
    },
  });
  _charts.set(chartId, chart);
}

// 仮想データセット配列を chartConfig のページ割り当てに従ってスライスする
// 新形式 splitDatasetIndices が優先、なければ旧形式 splitChunkStart/End で fallback
function _sliceVirtual(allVirtual, cs) {
  const indices = cs?.splitDatasetIndices;
  if (indices != null) {
    return indices.map(i => allVirtual[i]).filter(Boolean);
  }
  const s = cs?.splitChunkStart ?? 0;
  const e = cs?.splitChunkEnd   ?? allVirtual.length;
  return allVirtual.slice(s, e);
}

// ラベル配列を同じルールでスライスする
function _sliceLabels(allLabels, cs) {
  const indices = cs?.splitDatasetIndices;
  if (indices != null) {
    return indices.map(i => allLabels[i]).filter(l => l != null);
  }
  const s = cs?.splitChunkStart ?? 0;
  const e = cs?.splitChunkEnd   ?? allLabels.length;
  return allLabels.slice(s, e);
}

function _resolveSplitCols(pageLayout, splitColumns, n) {
  if (pageLayout === "cols1" || pageLayout === "vertical")  return 1;
  if (pageLayout === "horizontal")                          return n || 1;
  if (pageLayout === "cols2" || pageLayout === "grid2x2")   return 2;
  if (pageLayout === "cols3" || pageLayout === "grid3x2")   return 3;
  return splitColumns || (n <= 2 ? 1 : n <= 4 ? 2 : 3);
}

function _buildSmallMultiplesHtml(page, idSuffix, chartStyle, cs) {
  const splitMode = cs?.splitMode ?? "normal";
  let datasets;
  if (splitMode === "by_axis") {
    datasets = _buildSplitByAxisDatasetsR4(page);
  } else if (splitMode === "by_comparison") {
    datasets = _buildSplitByComparisonDatasetsR4(page);
  } else {
    datasets = page.comparison_datasets ?? [];
  }

  // ページ分割スライシング: 新形式(splitDatasetIndices)→旧形式(splitChunkStart/End)の順で fallback
  if (splitMode !== "normal") {
    const indices = cs?.splitDatasetIndices;
    if (indices != null) {
      datasets = indices.map(i => datasets[i]).filter(Boolean);
    } else {
      const chunkStart = cs?.splitChunkStart ?? 0;
      const chunkEnd   = cs?.splitChunkEnd   ?? datasets.length;
      datasets = datasets.slice(chunkStart, chunkEnd);
    }
  }

  const n         = datasets.length;
  const splitCols = _resolveSplitCols(cs?.pageLayout, cs?.splitColumns, n);
  const rowsCount = Math.ceil(n / splitCols);

  return `<div class="report-small-multiples" data-cols="${splitCols}" style="grid-template-rows:repeat(${rowsCount},1fr)">` +
    datasets.map((ds, dsIdx) =>
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
    const _filteredRows = _filterChoices(ds0.rows, cs);
    const allRows = (!cs.sortOrder || cs.sortOrder === "original")
      ? _applyRowChoiceOrder(_filteredRows, cs.rowChoiceOrder)
      : _filteredRows;
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

  // 選択肢フィルタ・手動並び替え
  rows = _filterChoices(rows, cs);
  if (!cs.sortOrder || cs.sortOrder === "original") {
    rows = _applyRowChoiceOrder(rows, cs.rowChoiceOrder);
  }

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

  const splitMode = cs.splitMode ?? "normal";
  const isSplitMode = splitMode !== "normal" && !opts.brandHbar && !opts.brandVbar;

  if (isSplitMode && !hasComparison) {
    // by_axis / by_comparison 分割（splitDatasetIndices → splitChunkStart/End 順で fallback）
    const allVirtual = splitMode === "by_axis"
      ? _buildSplitByAxisDatasetsR4(page)
      : _buildSplitByComparisonDatasetsR4(page);
    const virtualDatasets = _sliceVirtual(allVirtual, cs);
    const sharedMax = _calcSharedMaxR4(virtualDatasets);
    const allLabels = splitMode === "by_axis"
      ? (page.axis_categories ?? [])
      : (page.rows ?? []).map(r => r.label);
    const paletteLabels = _sliceLabels(allLabels, cs);
    const palette = _resolveColorsForPage(cs, paletteLabels);
    virtualDatasets.forEach((ds, dsIdx) => {
      const canvas = document.getElementById(`report-chart-${idSuffix}-${dsIdx}`);
      if (!canvas) return;
      _buildSplitSubChartR4(canvas, `${idSuffix}-${dsIdx}`, ds, cs, palette[dsIdx] ?? "#3B82F6", sharedMax);
    });
  } else if (opts.forceSmall || (hasComparison && !opts.brandHbar && !opts.brandVbar)) {
    const datasetsToRender = isSplitMode
      ? _sliceVirtual(
          splitMode === "by_axis" ? _buildSplitByAxisDatasetsR4(page) : _buildSplitByComparisonDatasetsR4(page),
          cs
        )
      : (page.comparison_datasets ?? []);
    const sharedMax = isSplitMode ? _calcSharedMaxR4(datasetsToRender) : null;
    const paletteLabels = isSplitMode
      ? (splitMode === "by_axis" ? (page.axis_categories ?? []) : (page.rows ?? []).map(r => r.label))
      : null;
    const palette = paletteLabels ? _resolveColorsForPage(cs, paletteLabels) : null;
    datasetsToRender.forEach((ds, dsIdx) => {
      const canvas = document.getElementById(`report-chart-${idSuffix}-${dsIdx}`);
      if (!canvas) return;
      if (isSplitMode) {
        _buildSplitSubChartR4(canvas, `${idSuffix}-${dsIdx}`, ds, cs, palette[dsIdx] ?? "#3B82F6", sharedMax);
      } else {
        _buildBarChart(canvas, `${idSuffix}-${dsIdx}`, ds.rows, ds.axis_categories, ds.axis_totals, cs, opts);
      }
    });
  } else {
    const canvas = document.getElementById(`report-chart-${idSuffix}`);
    if (!canvas) return;
    _buildBarChart(canvas, String(idSuffix), page.rows, page.axis_categories, page.axis_totals, cs, opts);
  }
}

function _sortedRows(rows, sortOrder) {
  if (!sortOrder || sortOrder === "original") return rows;
  return [...rows].sort((a, b) => {
    const avg = r => r.percents.reduce((s, v) => s + (v ?? 0), 0) / Math.max(r.percents.length, 1);
    return sortOrder === "asc" ? avg(a) - avg(b) : avg(b) - avg(a);
  });
}

function _buildBarChart(canvas, chartId, rows, axisCats, axisTotals, cs, opts) {
  if (!rows?.length || !axisCats?.length) return;
  cs = cs ?? _defaultChartSettings();

  // 選択肢フィルタ・並び順
  rows = _filterChoices(rows, cs);
  if (!cs.sortOrder || cs.sortOrder === "original") {
    rows = _applyRowChoiceOrder(rows, cs.rowChoiceOrder);
  }
  rows = _sortedRows(rows, cs.sortOrder);
  if (!rows.length) return;

  // 行列入れ替え（STEP3から継承、STEP4では変更不可）
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

  // 選択肢フィルタ・並び順（comparison_datasetsの最初のrowセット基準）
  const _brandApplyOrder = (rows) => {
    const filtered = _filterChoices(rows, cs);
    const ordered = (!cs.sortOrder || cs.sortOrder === "original")
      ? _applyRowChoiceOrder(filtered, cs.rowChoiceOrder)
      : filtered;
    return _sortedRows(ordered, cs.sortOrder);
  };
  const filteredDs = comparisonDatasets.map(ds => ({
    ...ds,
    rows: _brandApplyOrder(ds.rows),
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

  const _brandVApplyOrder = (rows) => {
    const filtered = _filterChoices(rows, cs);
    const ordered = (!cs.sortOrder || cs.sortOrder === "original")
      ? _applyRowChoiceOrder(filtered, cs.rowChoiceOrder)
      : filtered;
    return _sortedRows(ordered, cs.sortOrder);
  };
  const filteredDs = comparisonDatasets.map(ds => ({
    ...ds,
    rows: _brandVApplyOrder(ds.rows),
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
// ファネルページ（1ページ統合モード）
// ---------------------------------------------------------------------------

function _buildFunnelPage(page, idSuffix, cs) {
  const fd = page.funnelData;
  if (!fd?.questions?.length) return document.createElement("div");
  cs = cs ?? _defaultChartSettings();

  const title = cs.titleOverride ?? page.title ?? "ファネル比較";
  const subtitle = cs.showQuestionText ? (cs.questionTextOverride ?? "") : "";

  const wStyle = [];
  if (cs.chartHeightPx) wStyle.push(`height:${cs.chartHeightPx}px;flex:none;`);
  if (cs.chartWidthPx)  wStyle.push(`width:${cs.chartWidthPx}px;`);
  const chartStyle = wStyle.length ? `style="${wStyle.join("")}"` : "";

  const nParts = (fd.axisCategories ?? []).map((cat, i) =>
    `${_esc(cat)}: n=${fd.axisTotals?.[i] ?? "?"}`
  ).join("  /  ");

  const wrap = document.createElement("div");
  wrap.className = "report-page";
  wrap.innerHTML = `
    <div class="report-band-comparison">
      <div class="report-page-title">${_esc(title)}</div>
      ${subtitle ? `<div class="report-page-subtitle" style="font-size:${cs.subtitleFontSize ?? 8}px">${_esc(subtitle)}</div>` : ""}
    </div>
    <div class="report-page-body">
      <div class="report-page-export-row"></div>
      <div class="report-chart-wrap" ${chartStyle}>
        <canvas id="report-chart-${idSuffix}"></canvas>
      </div>
      <div class="report-page-footer">
        ${nParts ? `<span class="report-n-count">${nParts}</span>` : ""}
        <span class="report-axis-label">分析軸: ${_esc(fd.axisLabel ?? "")}</span>
      </div>
    </div>
  `;
  return wrap;
}

function _renderFunnelChart(page, idSuffix, cs) {
  const fd = page.funnelData;
  if (!fd?.questions?.length || !fd.axisCategories?.length) return;
  cs = cs ?? _defaultChartSettings();

  const canvas = document.getElementById(`report-chart-${idSuffix}`);
  if (!canvas) return;

  // labels = 設問ラベル（X軸）
  const labels = fd.questions.map(q => q.questionLabel);

  // datasets = ブランド（系列）ごとに設問ごとのtop box %
  const colors = _resolveColorsForPage(cs, fd.axisCategories);
  const datasets = fd.axisCategories.map((brand, bi) => ({
    label: brand,
    data: fd.questions.map(q => q.rows?.[0]?.percents?.[bi] ?? 0),
    backgroundColor: colors[bi],
    ...(cs.barThickness != null ? { barThickness: cs.barThickness } : {}),
  }));

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: "x",
      responsive: true,
      maintainAspectRatio: false,
      categoryPercentage: cs.categoryPercentage ?? 0.8,
      barPercentage: cs.barPercentage ?? 0.9,
      plugins: {
        legend: {
          display: cs.showLegend ?? true,
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
        x: { ticks: { font: { size: cs.axisFontSize ?? 10 } } },
        y: {
          beginAtZero: true,
          max: 100,
          ticks: { font: { size: cs.axisFontSize ?? 10 }, callback: (v) => `${v}%` },
        },
      },
    },
  });

  _charts.set(String(idSuffix), chart);
}

// ---------------------------------------------------------------------------
// PNG 出力
// ---------------------------------------------------------------------------

async function _exportActivePng() {
  const canvas = document.getElementById("report-preview-canvas");
  if (!canvas) return;
  const cvs = canvas.querySelectorAll("canvas");
  if (!cvs.length) { showToast("グラフがありません。", true); return; }
  const activePage = AppState.reportProject.pages.find(p => (p.id ?? p.pageId) === AppState.reportProject.activePageId);
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

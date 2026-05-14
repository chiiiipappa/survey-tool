/**
 * STEP2: 回答データ読込・ラベル変換 パネル UI ロジック。
 */
import { AppState, setStep2UploadResult, setStep2AxisSelection, setStep2FaMeta } from "./state.js";
import { uploadResponseFile, saveStep2Axis, exportLabeledData, getFaData, exportFaData, getFaMeta } from "./api.js";
import { showSpinner, hideSpinner, showToast, showError } from "./app.js";

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

export function initStep2Panel() {
  _initDropZone();
  _initTabSwitcher();
  _initAxisButtons();
  _initExportButton();
  _initFaCard();

  // ②側のチェックボックス変更を③の軸リスト・FA属性プルダウンへ同期
  document.addEventListener("survey:statechange", () => {
    const axisSelected = new Set(AppState.step2SelectedAxisColumns);
    document.querySelectorAll('#step2-axis-list input[name="axis"]').forEach(cb => {
      cb.checked = axisSelected.has(cb.value);
    });
    _updateAttrSelect();
    _updateSortAttrSelect();
  });
}

// ---------------------------------------------------------------------------
// ドラッグ&ドロップ / ファイル選択
// ---------------------------------------------------------------------------

function _initDropZone() {
  const dropZone = document.getElementById("step2-drop-zone");
  const fileInput = document.getElementById("step2-file-input");

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) _handleFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) _handleFile(file);
    fileInput.value = "";
  });
}

async function _handleFile(file) {
  if (!AppState.sessionToken) {
    showError("STEP1 でレイアウト CSV を先にアップロードしてください。");
    return;
  }

  const ext = file.name.split(".").pop().toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(ext)) {
    showError(`対応していないファイル形式です: .${ext}（.csv / .xlsx のみ）`);
    return;
  }

  showSpinner("回答データを解析中…");
  try {
    const resp = await uploadResponseFile(file, AppState.sessionToken);
    setStep2UploadResult(resp);
    _renderAll(resp);
    showToast("回答データを読み込みました。");
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

// ---------------------------------------------------------------------------
// 全描画
// ---------------------------------------------------------------------------

function _renderAll(resp) {
  renderFileInfoBar(resp);
  renderMatchCard(resp);
  renderPreviewCard(resp);
  renderAxisCard(resp);
  renderExportCard();
  renderFaCard(resp);
}

// ---------------------------------------------------------------------------
// ファイル情報バー
// ---------------------------------------------------------------------------

export function renderFileInfoBar(resp) {
  const bar = document.getElementById("step2-file-info-bar");
  const fmt = (n) => n.toLocaleString("ja-JP");
  bar.innerHTML = `
    <span>📄 <strong>${_esc(resp.filename)}</strong></span>
    <span class="badge">${_esc(resp.encoding_detected)}</span>
    <span>${fmt(resp.response_row_count)} 行</span>
    <span>${fmt(resp.response_col_count)} 列</span>
    <span>${(resp.file_size / 1024).toFixed(1)} KB</span>
  `;
  bar.classList.remove("hidden");

  const warnBox = document.getElementById("step2-warnings-box");
  const multiCols = resp.multi_select_columns ?? [];
  if (multiCols.length > 0) {
    warnBox.innerHTML = `
      <strong>⚠ 複数選択設問が検出されました（後続対応）</strong>
      <div class="text-sm" style="margin-top:4px">${multiCols.map(_esc).join("、")}</div>
    `;
    warnBox.classList.remove("hidden");
  } else {
    warnBox.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// 照合結果カード
// ---------------------------------------------------------------------------

export function renderMatchCard(resp) {
  const card    = document.getElementById("step2-match-card");
  const summary = document.getElementById("step2-match-summary");
  const detail  = document.getElementById("step2-match-detail");

  const matched      = resp.matched_columns ?? [];
  const extra        = resp.extra_columns ?? [];
  const bracketCols  = resp.bracket_columns ?? [];
  const missingDetails = resp.missing_column_details ?? [];

  // ブラケット照合済みの親コード集合
  const bracketBaseCodes = new Set(bracketCols.map(bc => bc.base_code));
  const normalMatchedCount = matched.filter(c => !bracketBaseCodes.has(c)).length;
  const bracketMatchedCount = bracketBaseCodes.size;

  // missing_column_details の verdict 別集計
  const parentOk    = missingDetails.filter(d => d.verdict === "parent_matched" || d.verdict === "bracket_expanded");
  const needCheck   = missingDetails.filter(d => d.verdict === "free_answer" || d.verdict === "need_check");
  const unmatched   = missingDetails.filter(d => d.verdict === "unmatched");

  // ---------- サマリーバッジ ----------
  const badgeParts = [];
  if (normalMatchedCount)    badgeParts.push(`<span class="badge badge-ok">正常に照合 ${normalMatchedCount}</span>`);
  if (bracketMatchedCount)   badgeParts.push(`<span class="badge badge-ok">展開列として照合 ${bracketMatchedCount}</span>`);
  if (parentOk.length)       badgeParts.push(`<span class="badge" style="background:var(--color-success-bg,#E8F9F7);color:var(--color-success-text,#1E8A7A)">回答不要の親設問 ${parentOk.length}</span>`);
  if (needCheck.length)      badgeParts.push(`<span class="badge badge-warn">要確認 ${needCheck.length}</span>`);
  if (unmatched.length)      badgeParts.push(`<span class="badge" style="background:var(--color-error-bg,#FDECEA);color:var(--color-error-text,#B8010F)">未照合 ${unmatched.length}</span>`);
  if (extra.length)          badgeParts.push(`<span class="badge badge-info">余分 ${extra.length}</span>`);
  summary.innerHTML = badgeParts.join("") || '<span class="badge">照合なし</span>';

  const sections = [];

  // ---------- 正常に照合 ----------
  const normalMatched = matched.filter(c => !bracketBaseCodes.has(c));
  if (normalMatched.length) {
    sections.push(`
      <div class="match-section">
        <div class="match-section-title text-sm" style="color:var(--color-success,#1E8A7A);font-weight:600;margin-bottom:6px">
          ✅ 正常に照合（${normalMatched.length}）
        </div>
        <div class="badge-list">${normalMatched.map(c => `<span class="badge badge-ok">${_esc(c)}</span>`).join("")}</div>
      </div>
    `);
  }

  // ---------- 展開列として照合 ----------
  if (bracketCols.length) {
    const groups = {};
    bracketCols.forEach(bc => {
      if (!groups[bc.base_code]) groups[bc.base_code] = [];
      groups[bc.base_code].push(bc);
    });
    const groupHtml = Object.entries(groups).map(([base, items]) => {
      const itemBadges = items.map(bc =>
        `<span class="badge badge-ok" title="${_esc(bc.display_header)}">${_esc(bc.column_name)}</span>`
      ).join("");
      return `<div style="margin-bottom:4px"><span class="badge" style="font-weight:600">${_esc(base)}</span> → ${itemBadges}</div>`;
    }).join("");
    sections.push(`
      <div class="match-section" style="margin-top:12px">
        <div class="match-section-title text-sm" style="color:var(--color-success,#1E8A7A);font-weight:600;margin-bottom:6px">
          📋 展開列として照合（設問 ${bracketMatchedCount} 件、列 ${bracketCols.length} 件）
        </div>
        ${groupHtml}
      </div>
    `);
  }

  // ---------- 不足列の詳細（分類別） ----------
  if (missingDetails.length) {
    sections.push(_renderMissingDetails(parentOk, needCheck, unmatched));
  }

  // ---------- 余分列 ----------
  if (extra.length) {
    sections.push(`
      <div class="match-section" style="margin-top:12px">
        <div class="match-section-title text-sm" style="color:var(--color-text-muted);font-weight:600;margin-bottom:6px">
          ℹ 回答データにのみ存在する列（${extra.length}）
        </div>
        <div class="badge-list">${extra.map(c => `<span class="badge">${_esc(c)}</span>`).join("")}</div>
      </div>
    `);
  }

  detail.innerHTML = sections.join("") || '<p class="text-sm text-muted">照合できた列はありません。</p>';
  card.style.display = "";
}

function _renderMissingDetails(parentOk, needCheck, unmatched) {
  const parts = [];

  if (parentOk.length) {
    parts.push(`
      <div class="match-section" style="margin-top:12px">
        <div class="match-section-title text-sm" style="color:var(--color-success,#1E8A7A);font-weight:600;margin-bottom:6px">
          ✅ 回答不要の親設問（${parentOk.length}）
        </div>
        ${_missingTable(parentOk)}
      </div>
    `);
  }

  if (needCheck.length) {
    parts.push(`
      <div class="match-section" style="margin-top:12px">
        <div class="match-section-title text-sm" style="color:var(--color-warning,#7A5200);font-weight:600;margin-bottom:6px">
          ⚠ 要確認（${needCheck.length}）
        </div>
        ${_missingTable(needCheck)}
      </div>
    `);
  }

  if (unmatched.length) {
    parts.push(`
      <div class="match-section" style="margin-top:12px">
        <div class="match-section-title text-sm" style="color:var(--color-error-text,#B8010F);font-weight:600;margin-bottom:6px">
          ❌ 未照合（${unmatched.length}）
        </div>
        ${_missingTable(unmatched)}
      </div>
    `);
  }

  return parts.join("");
}

function _missingTable(items) {
  const rows = items.map(d => {
    const related = d.related_response_cols.length
      ? d.related_response_cols.slice(0, 8).map(_esc).join(", ") +
        (d.related_response_cols.length > 8 ? `…（他 ${d.related_response_cols.length - 8} 件）` : "")
      : "—";
    const stubCell = d.stub ? `<td class="text-sm text-muted">${_esc(d.stub)}</td>` : `<td>—</td>`;
    return `
      <tr>
        <td><strong>${_esc(d.question_code)}</strong></td>
        <td class="text-sm">${_esc(d.type_label)}</td>
        <td class="text-sm">${_esc(d.question_text)}</td>
        ${stubCell}
        <td class="text-sm text-muted">${_esc(d.reason)}</td>
        <td class="text-sm">${related}</td>
      </tr>
    `;
  }).join("");

  return `
    <div style="overflow-x:auto">
      <table class="missing-detail-table" style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:var(--color-surface-2,#F8F8F8);text-align:left">
            <th style="padding:4px 8px;white-space:nowrap">コード</th>
            <th style="padding:4px 8px;white-space:nowrap">種別</th>
            <th style="padding:4px 8px">質問文</th>
            <th style="padding:4px 8px;white-space:nowrap">表側</th>
            <th style="padding:4px 8px">理由</th>
            <th style="padding:4px 8px;white-space:nowrap">対応する回答データ列</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// ラベル変換プレビューカード
// ---------------------------------------------------------------------------

export function renderPreviewCard(resp) {
  const card = document.getElementById("step2-preview-card");

  _renderPreviewTable("step2-preview-raw", resp.preview_rows ?? []);
  _renderPreviewTable("step2-preview-labeled", resp.labeled_preview_rows ?? []);
  _renderUnmatchedTable("step2-preview-unmatched", resp.unmatched_values ?? []);

  card.style.display = "";
}

function _renderPreviewTable(containerId, rows) {
  const el = document.getElementById(containerId);
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-muted" style="padding:16px">データがありません。</p>';
    return;
  }
  const cols = Object.keys(rows[0]);
  const thead = `<tr>${cols.map(c => `<th>${_esc(c)}</th>`).join("")}</tr>`;
  const tbody = rows.map(row =>
    `<tr>${cols.map(c => `<td>${_esc(String(row[c] ?? ""))}</td>`).join("")}</tr>`
  ).join("");
  el.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function _renderUnmatchedTable(containerId, items) {
  const el = document.getElementById(containerId);
  if (!items.length) {
    el.innerHTML = '<p class="text-sm" style="color:var(--color-success,#1E8A7A)">✅ すべての値が正常に変換されました。</p>';
    return;
  }
  const rows = items.map(u =>
    `<tr><td>${_esc(u.question_code)}</td><td>${_esc(String(u.value))}</td><td>${u.count}</td></tr>`
  ).join("");
  el.innerHTML = `
    <p class="text-sm text-muted" style="margin-bottom:8px">以下の値は変換辞書に存在せず、元値のまま保持されています。</p>
    <table>
      <thead><tr><th>設問コード</th><th>値</th><th>件数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// タブ切り替え
// ---------------------------------------------------------------------------

function _initTabSwitcher() {
  const tabBar = document.getElementById("step2-preview-tabs");
  tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabBar.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    ["raw", "labeled", "unmatched"].forEach(t => {
      document.getElementById(`step2-preview-${t}`).style.display = t === tab ? "" : "none";
    });
  });
}

// ---------------------------------------------------------------------------
// 集計軸選択カード
// ---------------------------------------------------------------------------

export function renderAxisCard(resp) {
  const card = document.getElementById("step2-axis-card");
  const list = document.getElementById("step2-axis-list");
  const candidates = resp.axis_candidates ?? [];

  if (!candidates.length) {
    list.innerHTML = '<p class="text-sm text-muted">集計軸候補がありません。</p>';
    card.style.display = "";
    return;
  }

  const selected = new Set(AppState.step2SelectedAxisColumns);
  list.innerHTML = candidates.map(c => {
    const isMulti = (resp.multi_select_columns ?? []).includes(c.question_code);
    const badge = isMulti
      ? `<span class="badge badge-warn" style="font-size:11px">後続対応</span>`
      : `<span class="badge" style="font-size:11px">${_esc(c.type_label)}</span>`;
    return `
      <label class="axis-item">
        <input type="checkbox" name="axis" value="${_esc(c.question_code)}"
          ${selected.has(c.question_code) ? "checked" : ""}>
        <span class="axis-code">${_esc(c.question_code)}</span>
        ${badge}
        <span class="axis-text text-sm text-muted">${_esc(c.question_text)}</span>
      </label>
    `;
  }).join("");

  card.style.display = "";
}

function _initAxisButtons() {
  document.getElementById("step2-save-axis-btn").addEventListener("click", handleAxisSave);
  document.getElementById("step2-select-all-btn").addEventListener("click", () => {
    document.querySelectorAll('#step2-axis-list input[name="axis"]').forEach(cb => cb.checked = true);
  });
  document.getElementById("step2-clear-all-btn").addEventListener("click", () => {
    document.querySelectorAll('#step2-axis-list input[name="axis"]').forEach(cb => cb.checked = false);
  });
}

export async function handleAxisSave() {
  if (!AppState.sessionToken) return;
  const selected = [...document.querySelectorAll('#step2-axis-list input[name="axis"]:checked')]
    .map(cb => cb.value);
  showSpinner("集計軸を保存中…");
  try {
    await saveStep2Axis(AppState.sessionToken, selected);
    setStep2AxisSelection(selected);
    showToast(`集計軸を保存しました（${selected.length} 列）`);
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

// ---------------------------------------------------------------------------
// エクスポートカード
// ---------------------------------------------------------------------------

export function renderExportCard() {
  document.getElementById("step2-export-card").style.display = "";
}

function _initExportButton() {
  document.getElementById("step2-export-btn").addEventListener("click", handleExport);
}

export async function handleExport() {
  if (!AppState.sessionToken) return;
  showSpinner("CSV を生成中…");
  try {
    await exportLabeledData(AppState.sessionToken);
    showToast("ダウンロードを開始しました。");
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

// ---------------------------------------------------------------------------
// FA 閲覧カード
// ---------------------------------------------------------------------------

const _faState = {
  keyColumnName: "",
  faColumns: [],
  _msQuestion: null,
  hasData: false,
};

export function renderFaCard(resp) {
  document.getElementById("step2-fa-card").style.display = "";
  _loadFaMeta();
}

function _initFaCard() {
  document.getElementById("fa-apply-btn").addEventListener("click", () => {
    const faCodes = _faState._msQuestion?.getSelected() ?? [];
    if (!faCodes.length) {
      showToast("FA設問を1つ以上選択してください。", true);
      return;
    }
    _loadFaData(_collectFaParams());
  });

  document.getElementById("fa-sort-select").addEventListener("change", (e) => {
    const attrSel = document.getElementById("fa-sort-attr-select");
    attrSel.style.display = e.target.value === "attr_order" ? "" : "none";
  });

  document.getElementById("fa-export-csv-btn").addEventListener("click", async () => {
    if (!AppState.sessionToken || !_faState.hasData) return;
    showSpinner("CSV を生成中…");
    try {
      await exportFaData(AppState.sessionToken, { ..._collectFaParams(), format: "csv" });
      showToast("CSV ダウンロードを開始しました。");
    } catch (err) {
      showError(err.message);
    } finally {
      hideSpinner();
    }
  });

  document.getElementById("fa-export-excel-btn").addEventListener("click", async () => {
    if (!AppState.sessionToken || !_faState.hasData) return;
    showSpinner("Excel を生成中…");
    try {
      await exportFaData(AppState.sessionToken, { ..._collectFaParams(), format: "excel" });
      showToast("Excel ダウンロードを開始しました。");
    } catch (err) {
      showError(err.message);
    } finally {
      hideSpinner();
    }
  });
}

async function _loadFaMeta() {
  if (!AppState.sessionToken) return;
  showSpinner("FA設問を読み込み中…");
  try {
    const meta = await getFaMeta(AppState.sessionToken);
    _faState.keyColumnName = meta.key_column_name ?? "";
    _faState.faColumns = meta.fa_columns ?? [];
    setStep2FaMeta(meta);
    _initMultiSelects(meta);
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

function _initMultiSelects(meta) {
  // FA設問マルチセレクト
  const faOptions = (meta.fa_columns ?? []).map(col => ({
    value: col.question_code,
    label: `${col.question_code}｜${col.question_text}`,
    badge: col.type_label,
  }));
  _faState._msQuestion = new FaMultiSelect("fa-question-ms", faOptions, {
    placeholder: "FA設問を検索・選択…",
  });

  // 属性列・ソートプルダウンを集計軸選択から構築
  _updateAttrSelect();
  _updateSortAttrSelect();
}

function _updateAttrSelect() {
  const sel = document.getElementById("fa-attr-select");
  if (!sel) return;
  const cur = sel.value;
  const candidateMap = new Map(AppState.step2AxisCandidates.map(c => [c.question_code, c]));
  sel.innerHTML = '<option value="">（属性なし）</option>' +
    AppState.step2SelectedAxisColumns.map(code => {
      const info = candidateMap.get(code);
      const label = info ? `${code}　${info.question_text}` : code;
      return `<option value="${_esc(code)}" ${code === cur ? "selected" : ""}>${_esc(label)}</option>`;
    }).join("");
}

function _updateSortAttrSelect() {
  const sel = document.getElementById("fa-sort-attr-select");
  if (!sel) return;
  const cur = sel.value;
  const candidateMap = new Map(AppState.step2AxisCandidates.map(c => [c.question_code, c]));
  sel.innerHTML = AppState.step2SelectedAxisColumns
    .map(code => {
      const info = candidateMap.get(code);
      const label = info ? `${code}　${info.question_text}` : code;
      return `<option value="${_esc(code)}" ${code === cur ? "selected" : ""}>${_esc(label)}</option>`;
    }).join("");
}

function _collectFaParams() {
  const attrVal = document.getElementById("fa-attr-select")?.value;
  return {
    attrColumns: attrVal ? [attrVal] : [],
    faCodes:     _faState._msQuestion?.getSelected() ?? [],
    excludeEmpty: document.getElementById("fa-exclude-empty").checked,
    minChars:    parseInt(document.getElementById("fa-min-chars").value, 10) || 0,
    sortBy:      document.getElementById("fa-sort-select").value,
    sortAttr:    document.getElementById("fa-sort-attr-select").value || "",
    keyword:     document.getElementById("fa-keyword").value.trim(),
  };
}

async function _loadFaData(params) {
  if (!AppState.sessionToken) return;
  showSpinner("自由回答を読み込み中…");
  try {
    const data = await getFaData(AppState.sessionToken, params);
    _faState.hasData = true;

    // 案内を非表示にして件数バーを表示
    document.getElementById("fa-guidance").style.display = "none";
    const countBar = document.getElementById("fa-count-bar");
    countBar.style.display = "";

    _renderFaTable(data);
    _updateFaCountBar(data);
    _setExportEnabled(true);
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

function _renderFaTable(data) {
  const wrap = document.getElementById("fa-table-wrap");
  const rows = data.rows ?? [];

  if (!rows.length) {
    wrap.innerHTML = '<p class="text-sm text-muted" style="padding:16px">条件に一致する回答がありません。</p>';
    return;
  }

  const showKey = !!_faState.keyColumnName;
  const attrCols = rows.length > 0 ? Object.keys(rows[0].attr_values) : [];

  const thead = `<tr>
    <th style="width:52px; text-align:right">RowID</th>
    ${showKey ? `<th style="white-space:nowrap">KEY</th>` : ""}
    ${attrCols.map(c => `<th style="white-space:nowrap">${_esc(c)}</th>`).join("")}
    <th style="width:90px; white-space:nowrap">設問コード</th>
    <th style="min-width:160px">質問文</th>
    <th style="min-width:240px">回答本文</th>
    <th style="width:56px; text-align:right">文字数</th>
  </tr>`;

  const tbody = rows.map((r, i) => `
    <tr>
      <td style="text-align:right; color:var(--color-text-muted)">${i + 1}</td>
      ${showKey ? `<td class="text-sm">${_esc(r.key_value ?? "")}</td>` : ""}
      ${attrCols.map(c => `<td class="text-sm">${_esc(r.attr_values[c] ?? "")}</td>`).join("")}
      <td class="text-sm"><strong>${_esc(r.question_code)}</strong></td>
      <td class="text-sm text-muted">${_esc(r.question_text)}</td>
      <td class="fa-answer-cell">${_esc(r.answer)}</td>
      <td class="fa-chars-cell text-sm">${r.char_count}</td>
    </tr>
  `).join("");

  wrap.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function _updateFaCountBar(data) {
  const bar = document.getElementById("fa-count-bar");
  const fmt = n => n.toLocaleString("ja-JP");
  if (data.total_fa_rows === data.filtered_row_count) {
    bar.textContent = `全 ${fmt(data.total_fa_rows)} 件`;
  } else {
    bar.textContent = `${fmt(data.filtered_row_count)} 件 / 全 ${fmt(data.total_fa_rows)} 件（フィルタ適用中）`;
  }
}

function _setExportEnabled(enabled) {
  document.getElementById("fa-export-csv-btn").disabled = !enabled;
  document.getElementById("fa-export-excel-btn").disabled = !enabled;
}

// ---------------------------------------------------------------------------
// FaMultiSelect — 検索付きマルチセレクトウィジェット
// ---------------------------------------------------------------------------

class FaMultiSelect {
  /**
   * @param {string} containerId - マウント先要素の ID
   * @param {Array<{value:string, label:string, badge?:string, badgeStyle?:string}>} options
   * @param {{placeholder?:string, initialSelected?:string[], onChange?:function}} config
   */
  constructor(containerId, options, { placeholder = "検索…", initialSelected = [], onChange = null } = {}) {
    this._el = document.getElementById(containerId);
    this._allOptions = options;
    this._selected = new Set(initialSelected);
    this._placeholder = placeholder;
    this._onChange = onChange;
    this._open = false;
    this._render();
    this._bindGlobalClick();
  }

  /** 選択中の value 配列を返す */
  getSelected() { return [...this._selected]; }

  /** 外部から選択状態を一括更新する（② → ③ 同期用） */
  setSelected(codes) {
    this._selected = new Set(codes);
    this._renderTags();
    if (this._els) this._renderOptions(this._els.search?.value ?? "");
  }

  // ---- プライベート ----

  _render() {
    this._el.innerHTML = `
      <div class="fa-ms-input-row" id="${this._el.id}-input-row">
        <div id="${this._el.id}-tags"></div>
        <input class="fa-ms-search" id="${this._el.id}-search"
               type="text" autocomplete="off" spellcheck="false"
               placeholder="${this._selected.size === 0 ? _esc(this._placeholder) : ""}">
      </div>
      <div class="fa-ms-dropdown" id="${this._el.id}-dropdown" style="display:none"></div>
    `;

    this._els = {
      inputRow: document.getElementById(`${this._el.id}-input-row`),
      tags:     document.getElementById(`${this._el.id}-tags`),
      search:   document.getElementById(`${this._el.id}-search`),
      dropdown: document.getElementById(`${this._el.id}-dropdown`),
    };

    this._els.inputRow.addEventListener("click", (e) => {
      if (!e.target.closest(".fa-ms-tag-remove")) {
        this._els.search.focus();
        this._openDropdown();
      }
    });

    this._els.search.addEventListener("input", () => this._renderOptions(this._els.search.value));
    this._els.search.addEventListener("focus", () => this._openDropdown());

    this._renderTags();
    this._renderOptions("");
  }

  _openDropdown() {
    this._els.dropdown.style.display = "";
    this._open = true;
  }

  _closeDropdown() {
    this._els.dropdown.style.display = "none";
    this._open = false;
  }

  _renderOptions(query) {
    const q = query.toLowerCase();
    const filtered = q
      ? this._allOptions.filter(o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      : this._allOptions;

    if (!filtered.length) {
      this._els.dropdown.innerHTML = '<div class="fa-ms-option-empty">候補なし</div>';
      return;
    }

    this._els.dropdown.innerHTML = filtered.map(o => {
      const sel = this._selected.has(o.value);
      const badgeHtml = o.badge
        ? `<span class="badge" style="font-size:10px;${o.badgeStyle ? o.badgeStyle : ""}">${_esc(o.badge)}</span>`
        : "";
      return `
        <div class="fa-ms-option ${sel ? "fa-ms-selected" : ""}" data-value="${_esc(o.value)}">
          <span class="fa-ms-check">${sel ? "✓" : ""}</span>
          <span class="fa-ms-option-label">${_esc(o.label)}</span>
          ${badgeHtml}
        </div>`;
    }).join("");

    this._els.dropdown.querySelectorAll(".fa-ms-option").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const val = el.dataset.value;
        if (this._selected.has(val)) this._selected.delete(val);
        else this._selected.add(val);
        this._renderTags();
        this._renderOptions(this._els.search.value);
        if (this._onChange) this._onChange([...this._selected]);
      });
    });
  }

  _renderTags() {
    const selected = this._allOptions.filter(o => this._selected.has(o.value));
    this._els.tags.innerHTML = selected.map(o => `
      <span class="fa-ms-tag" data-value="${_esc(o.value)}">
        <span class="fa-ms-tag-text" title="${_esc(o.label)}">${_esc(o.value)}</span>
        <button type="button" class="fa-ms-tag-remove" aria-label="削除">×</button>
      </span>
    `).join("");

    this._els.search.placeholder = this._selected.size === 0 ? this._placeholder : "";

    this._els.tags.querySelectorAll(".fa-ms-tag-remove").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const val = btn.closest(".fa-ms-tag").dataset.value;
        this._selected.delete(val);
        this._renderTags();
        this._renderOptions(this._els.search.value);
        if (this._onChange) this._onChange([...this._selected]);
      });
    });
  }

  _bindGlobalClick() {
    document.addEventListener("click", (e) => {
      if (this._open && !this._el.contains(e.target)) {
        this._closeDropdown();
      }
    });
  }
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

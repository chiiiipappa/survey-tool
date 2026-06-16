/**
 * STEP2: 回答データ読込・ラベル変換 パネル UI ロジック。
 */
import { AppState, setStep2UploadResult, setStep2FaMeta, setStep2FaCodes } from "./state.js";
import { uploadResponseFile, getStep2Progress, exportLabeledData, getFaData, exportFaData, getFaMeta, saveFaSettings, applyManualMatch, applyLabelFix } from "./api.js";
import { showProgress, updateProgress, hideProgress, showToast, showError, activatePanel, showSpinner, hideSpinner } from "./app.js";

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------

let _lastFile = null;
let _uploadAbortController = null;
let _pollInterval = null;
let _currentResp = null;   // 最後のアップロード/手動照合レスポンス

const UPLOAD_STEPS = [
  "ファイル送信中…",
  "ファイル解析中…",
  "変換辞書を構築中…",
  "ラベル変換中…",
  "MA展開・集計軸検出中…",
  "Parquet保存中…",
];

function _startProgressPoll(sessionToken) {
  _pollInterval = setInterval(async () => {
    try {
      const p = await getStep2Progress(sessionToken);
      if (!p) return;
      updateProgress(p.pct, -1, p.message);
    } catch (_) { /* ignore */ }
  }, 600);
}

function _stopProgressPoll() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}

export function initStep2Panel() {
  _initDropZone();
  _initLoadedCard();
  _initTabSwitcher();
  _initExportButton();
  _initFaCard();
  document.getElementById("step2-col-search")?.addEventListener("input", _applyColSearch);

  document.addEventListener("survey:statechange", () => {
    _updateAttrMultiSelect();
    _updateSortAttrSelect();
  });
}

// ---------------------------------------------------------------------------
// ドラッグ&ドロップ / ファイル選択
// ---------------------------------------------------------------------------

function _initDropZone() {
  const dropZone = document.getElementById("step2-drop-zone");
  const fileInput = document.getElementById("step2-file-input");

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) _handleFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) _handleFile(file);
  });
}

const RESPONSE_FORMAT_DISPLAY = { intage: "インテージ形式", questant: "クエスタント形式" };

// STEP1 で確定した調査形式（AppState.surveyFormat）を STEP2 の固定表示に反映する。
// STEP2 では形式を選択させない（旧ラジオボタン API との互換のため関数名は維持）。
export function setResponseFormatRadio(value) {
  const el = document.getElementById("response-format-fixed");
  if (!el) return;
  if (value === "intage" || value === "questant") {
    el.textContent = `回答データ形式：${RESPONSE_FORMAT_DISPLAY[value]}（調査票レイアウトから自動設定）`;
    el.classList.remove("is-unset");
  } else {
    el.textContent = "未確定（先にSTEP1で調査票レイアウトを読み込んでください）";
    el.classList.add("is-unset");
  }
}

async function _handleFile(file) {
  _lastFile = file;
  if (!AppState.sessionToken) {
    showError("STEP1 でレイアウト CSV を先にアップロードしてください。");
    return;
  }
  if (AppState.surveyFormat !== "intage" && AppState.surveyFormat !== "questant") {
    showError("先に調査票レイアウトを読み込み、形式を確定してください。");
    return;
  }

  const ext = file.name.split(".").pop().toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(ext)) {
    showError(`対応していないファイル形式です: .${ext}（.csv / .xlsx のみ）`);
    return;
  }

  const responseFormat = AppState.surveyFormat;

  _uploadAbortController = new AbortController();
  showProgress({
    title: "回答データを解析中…",
    steps: UPLOAD_STEPS,
    showCancel: true,
    onCancel: () => {
      _uploadAbortController?.abort();
      _stopProgressPoll();
    },
  });
  updateProgress(5, 0);
  _startProgressPoll(AppState.sessionToken);

  try {
    const resp = await uploadResponseFile(file, AppState.sessionToken, {
      signal: _uploadAbortController.signal,
      responseFormat,
    });
    _stopProgressPoll();
    updateProgress(100, UPLOAD_STEPS.length - 1, "完了");
    // 差し替え時: 保存済み手動照合ルールの列が存在するか確認
    const prevRules = _currentResp?.manual_match_rules ?? [];
    if (prevRules.length) {
      const newCols = new Set(resp.all_response_columns ?? []);
      const missing = [];
      for (const rule of prevRules) {
        for (const col of (rule.response_cols ?? [])) {
          if (!newCols.has(col)) missing.push(col);
        }
      }
      if (missing.length) {
        showToast(`⚠ 差し替えにより手動照合済みの列が見つかりません: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`, true);
      }
    }
    setStep2UploadResult(resp);
    _renderAll(resp);
    showToast("回答データを読み込みました。");
  } catch (err) {
    _stopProgressPoll();
    if (err.name === "AbortError") {
      showToast("アップロードをキャンセルしました。");
      return;
    }
    showError(err.message);
  } finally {
    hideProgress();
    _uploadAbortController = null;
  }
}

// ---------------------------------------------------------------------------
// 全描画
// ---------------------------------------------------------------------------

function _renderAll(resp) {
  _currentResp = resp;
  _mmInit(resp);
  renderFileInfoBar(resp);
  renderAdvancedCard(resp);
  renderPreviewCard(resp);
  renderSelectedAxisDisplay(resp);
  document.getElementById("step2-upload-card").style.display = "none";
  _renderStep2LoadedInfo(resp);
  _renderDataInfoItems(resp);
  document.getElementById("step2-data-info-card").style.display = "";
  document.getElementById("step2-match-result-card").style.display = "";
  document.getElementById("step2-to-step3-card").style.display = "";
  document.getElementById("step2-fa-form-card").style.display = "";
  document.getElementById("step2-loaded-card").style.display = "";
  _loadFaMeta();
}

function _renderDataInfoItems(resp) {
  const el = document.getElementById("step2-data-info-items");
  if (!el) return;
  const fmt = (n) => typeof n === "number" ? n.toLocaleString("ja-JP") : (n ?? "–");
  const now = new Date().toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `
    <div class="step1-info-item">
      <span class="step1-info-label">ファイル名</span>
      <span class="step1-info-value">${_esc(resp.filename)}</span>
    </div>
    <div class="step1-info-item">
      <span class="step1-info-label">回答件数</span>
      <span class="step1-info-value">${fmt(resp.response_row_count)} 件</span>
    </div>
    <div class="step1-info-item">
      <span class="step1-info-label">列数</span>
      <span class="step1-info-value">${fmt(resp.response_col_count)} 列</span>
    </div>
    <div class="step1-info-item">
      <span class="step1-info-label">読込日時</span>
      <span class="step1-info-value">${now}</span>
    </div>
  `;
}

function _renderStep2LoadedInfo(resp) {
  const el = document.getElementById("step2-loaded-info");
  if (!el) return;
  el.innerHTML = `
    <span>📊 <strong>${_esc(resp.filename)}</strong></span>
    <span class="badge">${_esc(resp.encoding_detected)}</span>
    <span>${resp.response_row_count.toLocaleString("ja-JP")} 行</span>
    <span>${resp.response_col_count.toLocaleString("ja-JP")} 列</span>
    <span>${(resp.file_size / 1024).toFixed(1)} KB</span>
  `;
}

function _resetStep2() {
  _lastFile = null;
  document.getElementById("step2-upload-card").style.display = "";
  document.getElementById("step2-data-info-card").style.display = "none";
  document.getElementById("step2-match-result-card").style.display = "none";
  document.getElementById("step2-to-step3-card").style.display = "none";
  document.getElementById("step2-fa-form-card").style.display = "none";
  document.getElementById("step2-fa-card").style.display = "none";
  document.getElementById("step2-loaded-card").style.display = "none";
  setResponseFormatRadio(AppState.surveyFormat);
}

export function resetStep2UI() {
  _currentResp = null;
  _mmAllResponseCols = [];
  _mmItems = [];
  _mmSelections = {};
  _mmPickers = {};
  _rawRows = [];
  _labeledRows = [];
  _pendingFixes = {};
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  if (_uploadAbortController) { _uploadAbortController.abort(); _uploadAbortController = null; }
  _resetStep2();
}

function _initLoadedCard() {
  const step2ReplaceInput    = document.getElementById("step2-replace-input");
  const step2ReplaceDropZone = document.getElementById("step2-replace-drop-zone");

  if (step2ReplaceDropZone) {
    step2ReplaceDropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      step2ReplaceDropZone.classList.add("dragover");
    });
    step2ReplaceDropZone.addEventListener("dragleave", () =>
      step2ReplaceDropZone.classList.remove("dragover"));
    step2ReplaceDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      step2ReplaceDropZone.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file) _handleFile(file);
    });
  }

  step2ReplaceInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) _handleFile(file);
  });

  document.getElementById("btn-step2-reload")?.addEventListener("click", () => {
    if (_lastFile) _handleFile(_lastFile);
  });

  document.getElementById("btn-step2-unload")?.addEventListener("click", _resetStep2);
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
// ③ 選択済み集計軸表示（STEP1 から引き継ぎ、読み取り専用）
// ---------------------------------------------------------------------------

function renderSelectedAxisDisplay(resp) {
  _faState.validatedStep1Axes = (resp.axis_candidates ?? []).map(c => c.question_code);
}

// ---------------------------------------------------------------------------
// 折りたたみカード（データ変換・出力）
// ---------------------------------------------------------------------------

export function renderAdvancedCard(resp) {
  renderMatchCard(resp);
}

function _initCollapsible() {
  document.getElementById("step2-advanced-toggle").addEventListener("click", () => {
    const body = document.getElementById("step2-advanced-body");
    const chv  = document.getElementById("step2-adv-chevron");
    const open = body.style.display === "none";
    body.style.display = open ? "" : "none";
    chv.textContent = open ? "▼" : "▶";
  });
}

// ---------------------------------------------------------------------------
// 照合結果（要確認・未照合のみ表示）
// ---------------------------------------------------------------------------

export function renderMatchCard(resp) {
  const summary = document.getElementById("step2-match-summary");
  const detail  = document.getElementById("step2-match-detail");

  const matched        = resp.matched_columns ?? [];
  const extra          = resp.extra_columns ?? [];
  const bracketCols    = resp.bracket_columns ?? [];
  const missingDetails = resp.missing_column_details ?? [];

  const bracketBaseCodes = new Set(bracketCols.map(bc => bc.base_code));
  const normalMatchedCount  = matched.filter(c => !bracketBaseCodes.has(c)).length;
  const bracketMatchedCount = bracketBaseCodes.size;

  const parentOk      = missingDetails.filter(d => d.verdict === "parent_matched" || d.verdict === "bracket_expanded");
  const manualMatched = missingDetails.filter(d => d.verdict === "manual_matched");
  const needCheck     = missingDetails.filter(d => d.verdict === "free_answer" || d.verdict === "need_check");
  const unmatched     = missingDetails.filter(d => d.verdict === "unmatched");

  // サマリーバッジ
  const okTotal = normalMatchedCount + bracketMatchedCount + parentOk.length + manualMatched.length;
  const badgeParts = [];
  if (okTotal)              badgeParts.push(`<span class="badge badge-ok">照合済 ${okTotal}</span>`);
  if (needCheck.length)     badgeParts.push(`<span class="badge badge-warn">要確認 ${needCheck.length}</span>`);
  if (unmatched.length)     badgeParts.push(`<span class="badge" style="background:var(--color-error-bg,#FDECEA);color:var(--color-error-text,#B8010F)">未照合 ${unmatched.length}</span>`);
  if (manualMatched.length) badgeParts.push(`<span class="badge badge-ok">手動照合済 ${manualMatched.length}</span>`);
  if (extra.length)         badgeParts.push(`<span class="badge badge-info">余分 ${extra.length}</span>`);
  summary.innerHTML = badgeParts.join("") || "";

  const sections = [];

  if (manualMatched.length) {
    const rows = manualMatched.map(d => {
      const cols = d.related_response_cols?.length
        ? d.related_response_cols.map(_esc).join(", ")
        : "—";
      return `<tr>
        <td><strong>${_esc(d.question_code)}</strong></td>
        <td class="text-sm">${_esc(d.type_label)}</td>
        <td class="text-sm">${_esc(d.question_text)}</td>
        <td class="text-sm" style="color:var(--color-success-text,#1E8A7A)">${cols}</td>
      </tr>`;
    }).join("");
    sections.push(`
      <div class="match-section">
        <div class="match-section-title text-sm" style="color:var(--color-success-text,#1E8A7A);font-weight:600;margin-bottom:6px">
          ✓ 手動照合済（${manualMatched.length}）
        </div>
        <div style="overflow-x:auto">
          <table class="missing-detail-table" style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:var(--color-surface-2,#F8F8F8);text-align:left">
              <th style="padding:4px 8px">コード</th>
              <th style="padding:4px 8px">種別</th>
              <th style="padding:4px 8px">質問文</th>
              <th style="padding:4px 8px">対応する回答データ列</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `);
  }

  if (needCheck.length) {
    sections.push(`
      <div class="match-section" style="margin-top:${manualMatched.length ? 12 : 0}px">
        <div class="match-section-title text-sm" style="color:var(--color-warning,#7A5200);font-weight:600;margin-bottom:6px">
          ⚠ 要確認（${needCheck.length}）
        </div>
        ${_missingTable(needCheck)}
      </div>
    `);
  }

  if (unmatched.length) {
    sections.push(`
      <div class="match-section" style="margin-top:12px">
        <div class="match-section-title text-sm" style="color:var(--color-error-text,#B8010F);font-weight:600;margin-bottom:6px">
          ❌ 未照合（${unmatched.length}）
        </div>
        ${_missingTable(unmatched)}
      </div>
    `);
  }

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

  const actionableItems = needCheck.length + unmatched.length;
  const mmBtnHtml = actionableItems > 0 ? `
    <div style="margin-top:14px">
      <button id="btn-mmatch-open" class="btn-secondary" type="button"
        style="font-size:.82rem;padding:5px 12px">
        ✏ 照合を修正（${actionableItems}件）
      </button>
    </div>
    <div id="mmatch-panel-wrap" style="display:none;margin-top:10px"></div>
  ` : "";

  detail.innerHTML = (sections.join("") ||
    '<p class="text-sm" style="color:var(--color-success,#1E8A7A)">✅ すべての設問コードが正常に照合されました。</p>') +
    mmBtnHtml;

  // 手動照合ボタンのイベント
  document.getElementById("btn-mmatch-open")?.addEventListener("click", () => {
    const wrap = document.getElementById("mmatch-panel-wrap");
    if (!wrap) return;
    if (wrap.style.display === "none") {
      _mmInit(resp);
      _renderMmPanel(wrap);
      wrap.style.display = "";
      document.getElementById("btn-mmatch-open").textContent = "✕ 照合修正を閉じる";
    } else {
      wrap.style.display = "none";
      document.getElementById("btn-mmatch-open").textContent = `✏ 照合を修正（${actionableItems}件）`;
    }
  });

  // コンパクト表示
  const compactEl = document.getElementById("step2-match-compact");
  if (compactEl) {
    const unmatchedValCount = (resp.unmatched_values ?? []).length;
    const hasIssues = needCheck.length > 0 || unmatched.length > 0;
    if (!hasIssues) {
      compactEl.innerHTML = `
        <div class="step2-match-compact-row">
          <div class="step2-match-status-badge step2-match-status-ok">✓ 全設問照合完了</div>
          <div class="step2-match-stats">
            <span>照合数: <strong>${okTotal}問</strong></span>
            <span>変換不可値: <strong>${unmatchedValCount}件</strong></span>
          </div>
        </div>
      `;
    } else {
      compactEl.innerHTML = `
        <div class="step2-match-compact-row">
          <div class="step2-match-status-badge step2-match-status-warn">⚠ ${unmatched.length ? "照合に問題があります" : "要確認の項目があります"}</div>
          <div class="step2-match-stats">
            <span>照合済: <strong>${okTotal}問</strong></span>
            ${needCheck.length ? `<span>要確認: <strong>${needCheck.length}</strong></span>` : ""}
            ${unmatched.length ? `<span>未照合: <strong>${unmatched.length}</strong></span>` : ""}
            <span>変換不可値: <strong>${unmatchedValCount}件</strong></span>
          </div>
        </div>
      `;
    }
  }
}

// ---------------------------------------------------------------------------
// 手動照合パネル描画
// ---------------------------------------------------------------------------

function _renderMmPanel(wrapEl) {
  // 各行の ManualColPicker を生成
  const rowsHtml = _mmItems.map(item => {
    const sel = [...(_mmSelections[item.layoutCode] ?? [])];
    const chipsHtml = sel.length
      ? sel.map(c => `
          <span class="mmatch-chip" data-code="${_esc(item.layoutCode)}" data-col="${_esc(c)}">
            ${_esc(c)}<button class="mmatch-chip-remove" type="button" aria-label="削除">×</button>
          </span>`).join("")
      : '<span class="mmatch-empty-chip">未選択</span>';

    return `
      <div class="mmatch-row" data-code="${_esc(item.layoutCode)}">
        <div class="mmatch-row-header">
          <strong class="mmatch-code">${_esc(item.layoutCode)}</strong>
          <span class="badge" style="font-size:11px">${_esc(item.typeLabel)}</span>
          <span class="mmatch-qtext">${_esc(item.questionText)}</span>
        </div>
        <div class="mmatch-row-body">
          <span class="mmatch-row-label">対応列:</span>
          <div class="mmatch-ms-wrap" id="mmatch-ms-${_esc(item.layoutCode).replace(/[^a-z0-9]/gi, "_")}"></div>
        </div>
      </div>
    `;
  }).join("");

  wrapEl.innerHTML = `
    <div class="mmatch-panel">
      <div class="mmatch-panel-title">✏ 手動照合パネル</div>
      <div class="mmatch-toolbar">
        <button id="btn-mmatch-prefix" type="button" class="btn-secondary" style="font-size:.8rem;padding:4px 10px">
          前方一致で自動対応
        </button>
        <button id="btn-mmatch-similar" type="button" class="btn-secondary" style="font-size:.8rem;padding:4px 10px">
          コード類似で自動対応
        </button>
      </div>
      <div class="mmatch-rows">${rowsHtml}</div>
      <div class="mmatch-actions">
        <button id="btn-mmatch-apply" type="button" class="btn-primary" style="font-size:.85rem;padding:5px 16px">
          照合を適用
        </button>
        <button id="btn-mmatch-cancel" type="button" class="btn-secondary" style="font-size:.85rem;padding:5px 12px">
          キャンセル
        </button>
      </div>
    </div>
  `;

  // 各行に ManualColPicker をマウント
  for (const item of _mmItems) {
    const safeId = item.layoutCode.replace(/[^a-z0-9]/gi, "_");
    const mountEl = document.getElementById(`mmatch-ms-${safeId}`);
    if (!mountEl) continue;
    const sorted = _mmSortCols(item.layoutCode, _mmAllResponseCols);
    const sel = [...(_mmSelections[item.layoutCode] ?? [])];
    const picker = new ManualColPicker(mountEl, sorted, sel, (newSel) => {
      _mmSelections[item.layoutCode] = new Set(newSel);
    });
    _mmPickers[item.layoutCode] = picker;
  }

  // ツールバーボタン
  document.getElementById("btn-mmatch-prefix")?.addEventListener("click", () => {
    _mmAutoPrefix();
    _renderMmPanel(wrapEl);
  });
  document.getElementById("btn-mmatch-similar")?.addEventListener("click", () => {
    _mmAutoSimilar();
    _renderMmPanel(wrapEl);
  });
  document.getElementById("btn-mmatch-apply")?.addEventListener("click", _mmApply);
  document.getElementById("btn-mmatch-cancel")?.addEventListener("click", () => {
    wrapEl.style.display = "none";
    const openBtn = document.getElementById("btn-mmatch-open");
    if (openBtn) openBtn.textContent = `✏ 照合を修正（${_mmItems.length}件）`;
  });
}

// ---------------------------------------------------------------------------
// ManualColPicker — 手動照合用列選択ウィジェット
// ---------------------------------------------------------------------------

class ManualColPicker {
  /**
   * @param {HTMLElement} mountEl - マウント先要素
   * @param {string[]} allCols    - 選択肢（ソート済み）
   * @param {string[]} initSel    - 初期選択
   * @param {function} onChange   - 選択変更コールバック (newSel: string[]) => void
   */
  constructor(mountEl, allCols, initSel, onChange) {
    this._el = mountEl;
    this._allCols = allCols;
    this._selected = new Set(initSel);
    this._onChange = onChange;
    this._open = false;
    this._render();
  }

  setSelected(cols) {
    this._selected = new Set(cols);
    this._renderTags();
    if (this._dropdownEl) this._renderOptions(this._searchEl?.value ?? "");
    this._onChange([...this._selected]);
  }

  _render() {
    this._el.innerHTML = `
      <div class="mcp-wrap">
        <div class="mcp-tags-row" tabindex="0">
          <div class="mcp-tags"></div>
          <button class="mcp-toggle-btn" type="button">▾ 列を選択</button>
        </div>
        <div class="mcp-dropdown" style="display:none">
          <input class="mcp-search" type="text" placeholder="列名で絞り込み…" autocomplete="off">
          <div class="mcp-list"></div>
        </div>
      </div>
    `;

    this._tagsEl    = this._el.querySelector(".mcp-tags");
    this._toggleBtn = this._el.querySelector(".mcp-toggle-btn");
    this._dropdownEl = this._el.querySelector(".mcp-dropdown");
    this._searchEl  = this._el.querySelector(".mcp-search");
    this._listEl    = this._el.querySelector(".mcp-list");

    this._toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleDropdown();
    });
    this._searchEl.addEventListener("input", () => this._renderOptions(this._searchEl.value));
    document.addEventListener("click", (e) => {
      if (this._open && !this._el.contains(e.target)) this._closeDropdown();
    });

    this._renderTags();
    this._renderOptions("");
  }

  _toggleDropdown() {
    if (this._open) this._closeDropdown();
    else this._openDropdown();
  }

  _openDropdown() {
    this._dropdownEl.style.display = "";
    this._open = true;
    this._searchEl.focus();
  }

  _closeDropdown() {
    this._dropdownEl.style.display = "none";
    this._open = false;
  }

  _renderTags() {
    const chips = [...this._selected].map(c => `
      <span class="mmatch-chip" data-col="${_esc(c)}">
        ${_esc(c)}<button class="mmatch-chip-remove" type="button" aria-label="削除">×</button>
      </span>`).join("") || '<span class="mmatch-empty-chip">未選択</span>';
    this._tagsEl.innerHTML = chips;
    this._tagsEl.querySelectorAll(".mmatch-chip-remove").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const col = btn.closest(".mmatch-chip").dataset.col;
        this._selected.delete(col);
        this._renderTags();
        this._renderOptions(this._searchEl?.value ?? "");
        this._onChange([...this._selected]);
      });
    });
  }

  _renderOptions(query) {
    const q = query.toLowerCase();
    const filtered = q
      ? this._allCols.filter(c => c.toLowerCase().includes(q))
      : this._allCols;

    if (!filtered.length) {
      this._listEl.innerHTML = '<div class="mcp-empty">候補なし</div>';
      return;
    }

    this._listEl.innerHTML = filtered.map(c => {
      const sel = this._selected.has(c);
      return `
        <div class="mcp-option ${sel ? "mcp-selected" : ""}" data-col="${_esc(c)}">
          <span class="mcp-check">${sel ? "✓" : ""}</span>
          <span>${_esc(c)}</span>
        </div>`;
    }).join("");

    this._listEl.querySelectorAll(".mcp-option").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const col = el.dataset.col;
        if (this._selected.has(col)) this._selected.delete(col);
        else this._selected.add(col);
        this._renderTags();
        this._renderOptions(this._searchEl?.value ?? "");
        this._onChange([...this._selected]);
      });
    });
  }
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
// 手動照合パネル ステート
// ---------------------------------------------------------------------------

let _mmAllResponseCols = [];      // 全回答データ列名
let _mmItems = [];                 // {layoutCode, typeLabel, questionText} — 対象行
let _mmSelections = {};            // layoutCode → Set<string>
let _mmPickers = {};               // layoutCode → ManualColPicker

function _mmInit(resp) {
  _mmAllResponseCols = resp.all_response_columns ?? [];
  const details = resp.missing_column_details ?? [];
  // 要確認・未照合のみ対象（手動照合済み・展開済みは除外）
  _mmItems = details
    .filter(d => d.verdict === "need_check" || d.verdict === "unmatched" || d.verdict === "free_answer")
    .map(d => ({
      layoutCode: d.question_code,
      typeLabel: d.type_label,
      questionText: d.question_text,
      stub: d.stub,
    }));
  _mmSelections = {};
  _mmPickers = {};
}

function _mmSortCols(layoutCode, cols) {
  const code = layoutCode.toLowerCase();
  const selectedByOthers = new Set();
  for (const [lc, sel] of Object.entries(_mmSelections)) {
    if (lc !== layoutCode) for (const c of sel) selectedByOthers.add(c);
  }
  return [...cols].sort((a, b) => {
    const ra = _mmColRank(a.toLowerCase(), code, selectedByOthers, a);
    const rb = _mmColRank(b.toLowerCase(), code, selectedByOthers, b);
    return ra !== rb ? ra - rb : a.localeCompare(b, "ja");
  });
}

function _mmColRank(col, code, selectedByOthers, origCol) {
  if (col === code) return 0;
  if (col.startsWith(code + "_") || col.startsWith(code + "-") || col.startsWith(code + ".")) return 1;
  if (col.startsWith(code)) return 2;
  if (col.includes(code)) return 3;
  if (!selectedByOthers.has(origCol)) return 4;
  return 5;
}

function _mmAutoPrefix() {
  for (const item of _mmItems) {
    const code = item.layoutCode.toLowerCase();
    const matched = _mmAllResponseCols.filter(c =>
      c.toLowerCase().startsWith(code + "_") ||
      c.toLowerCase().startsWith(code + "-") ||
      c.toLowerCase().startsWith(code + ".")
    );
    if (matched.length) {
      _mmSelections[item.layoutCode] = new Set(matched);
      _mmPickers[item.layoutCode]?.setSelected(matched);
    }
  }
}

function _mmAutoSimilar() {
  for (const item of _mmItems) {
    const code = item.layoutCode.toLowerCase();
    const matched = _mmAllResponseCols.filter(c => c.toLowerCase().includes(code));
    if (matched.length) {
      _mmSelections[item.layoutCode] = new Set(matched);
      _mmPickers[item.layoutCode]?.setSelected(matched);
    }
  }
}

async function _mmApply() {
  if (!AppState.sessionToken) return;
  const rules = Object.entries(_mmSelections)
    .filter(([, sel]) => sel.size > 0)
    .map(([layoutCode, sel]) => ({ layout_code: layoutCode, response_cols: [...sel] }));

  if (!rules.length) {
    showToast("対応づける列を選択してください。", true);
    return;
  }

  showSpinner("手動照合を適用中…");
  try {
    const result = await applyManualMatch(AppState.sessionToken, rules);

    // 警告表示
    if (result.warnings?.length) {
      showToast("⚠ " + result.warnings.join(" / "), true);
    }

    // レスポンスで照合結果・プレビューを更新
    const mergedResp = {
      ...(_currentResp ?? {}),
      matched_columns: result.matched_columns,
      extra_columns: result.extra_columns,
      missing_column_details: result.missing_column_details,
      labeled_preview_rows: result.labeled_preview_rows,
      unmatched_values: result.unmatched_values ?? [],
      manual_match_rules: result.manual_match_rules ?? [],
    };
    _currentResp = mergedResp;
    setStep2UploadResult(mergedResp);
    renderMatchCard(mergedResp);
    // ラベル変換済みプレビュー更新
    _labeledRows = result.labeled_preview_rows ?? [];
    _applyColSearch();
    showToast("手動照合を適用しました。");
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

// ---------------------------------------------------------------------------
// ラベル変換プレビューカード
// ---------------------------------------------------------------------------

let _rawRows = [];
let _labeledRows = [];

export function renderPreviewCard(resp) {
  _rawRows = resp.preview_rows ?? [];
  _labeledRows = resp.labeled_preview_rows ?? [];
  _applyColSearch();
  const unmatched = resp.unmatched_values ?? [];
  _renderUnmatchedTable("step2-preview-unmatched", unmatched);
  // 変換不可値が存在する場合は自動的にそのタブを表示
  _activateTab(unmatched.length > 0 ? "unmatched" : "raw");
}

function _applyColSearch() {
  const q = (document.getElementById("step2-col-search")?.value ?? "").trim().toLowerCase();
  _renderPreviewTable("step2-preview-raw", _rawRows, q);
  _renderLabeledPreviewTable("step2-preview-labeled", _labeledRows, q);
}

const PREVIEW_COL_LIMIT = 50; // 表示列の上限。超過分は「他N列を表示」ボタンで展開

function _renderLabeledPreviewTable(containerId, rows, colFilter = "") {
  const el = document.getElementById(containerId);
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-muted" style="padding:16px">データがありません。</p>';
    return;
  }
  const questionMap = new Map(AppState.questions.map(q => [q.question_code, q.question_text]));
  const allCols = Object.keys(rows[0]);
  const filtered = colFilter
    ? allCols.filter((c, i) => {
        if (i === 0) return true;
        const text = (questionMap.get(c) ?? c).toLowerCase();
        return c.toLowerCase().includes(colFilter) || text.includes(colFilter);
      })
    : allCols;
  const cols = filtered.slice(0, PREVIEW_COL_LIMIT);
  const hiddenCount = filtered.length - cols.length;
  const numStyle = `style="width:40px;text-align:right;color:var(--color-text-muted)"`;
  const thead = `<tr><th ${numStyle}>#</th>${cols.map(c => {
    const title = questionMap.get(c) ?? c;
    return `<th title="${_esc(c)}">${_esc(title)}</th>`;
  }).join("")}</tr>`;
  const tbody = rows.map((row, i) =>
    `<tr><td ${numStyle}>${i + 1}</td>${cols.map(c => `<td>${_esc(String(row[c] ?? ""))}</td>`).join("")}</tr>`
  ).join("");
  const moreBtn = hiddenCount > 0
    ? `<p class="text-sm" style="padding:8px 0; color:var(--color-text-muted)">他 ${hiddenCount} 列を非表示（列フィルターで絞り込めます）</p>`
    : "";
  el.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>${moreBtn}`;
}

function _renderPreviewTable(containerId, rows, colFilter = "") {
  const el = document.getElementById(containerId);
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-muted" style="padding:16px">データがありません。</p>';
    return;
  }
  const questionMap = new Map(AppState.questions.map(q => [q.question_code, q.question_text]));
  const allCols = Object.keys(rows[0]);
  const filtered = colFilter
    ? allCols.filter((c, i) => {
        if (i === 0) return true;
        const text = (questionMap.get(c) ?? "").toLowerCase();
        return c.toLowerCase().includes(colFilter) || text.includes(colFilter);
      })
    : allCols;
  const cols = filtered.slice(0, PREVIEW_COL_LIMIT);
  const hiddenCount = filtered.length - cols.length;
  const numStyle = `style="width:40px;text-align:right;color:var(--color-text-muted)"`;
  const thead = `<tr><th ${numStyle}>#</th>${cols.map(c => {
    const tip = questionMap.get(c);
    return tip ? `<th title="${_esc(tip)}">${_esc(c)}</th>` : `<th>${_esc(c)}</th>`;
  }).join("")}</tr>`;
  const tbody = rows.map((row, i) =>
    `<tr><td ${numStyle}>${i + 1}</td>${cols.map(c => `<td>${_esc(String(row[c] ?? ""))}</td>`).join("")}</tr>`
  ).join("");
  const moreBtn = hiddenCount > 0
    ? `<p class="text-sm" style="padding:8px 0; color:var(--color-text-muted)">他 ${hiddenCount} 列を非表示（列フィルターで絞り込めます）</p>`
    : "";
  el.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>${moreBtn}`;
}

// 変換不可値の選択状態を永続保持（再描画しても消えない）
// key: `${qcode}\0${rawVal}` → { question_code, raw_value, label }
let _pendingFixes = {};
let _unmatchedClickHandler = null;
let _unmatchedChangeHandler = null;

function _pendingKey(qcode, rawVal) {
  return `${qcode}\0${rawVal}`;
}

function _updateBulkBarCount(el) {
  const count = Object.keys(_pendingFixes).length;
  const countEl = el.querySelector(".unmatched-pending-count");
  if (countEl) countEl.textContent = count > 0 ? `適用待ち ${count}件` : "適用待ちなし";
  const bulkBtn = el.querySelector(".unmatched-bulk-btn");
  if (bulkBtn) bulkBtn.disabled = count === 0;
}

function _renderUnmatchedTable(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;

  _updateUnmatchedMeta(items.length);

  // 古いハンドラを除去
  if (_unmatchedClickHandler) {
    el.removeEventListener("click", _unmatchedClickHandler);
    _unmatchedClickHandler = null;
  }
  if (_unmatchedChangeHandler) {
    el.removeEventListener("change", _unmatchedChangeHandler);
    _unmatchedChangeHandler = null;
  }

  if (!items.length) {
    el.innerHTML = '<p class="text-sm" style="color:var(--color-success,#1E8A7A)">✅ すべての値が正常に変換されました。</p>';
    return;
  }

  const codebook = AppState.step2Codebook ?? {};

  const rows = items.map((u, idx) => {
    const qcode = u.question_code;
    const rawValue = String(u.value);
    const key = _pendingKey(qcode, rawValue);
    const pending = _pendingFixes[key];

    const choiceMap = codebook[qcode] ?? {};
    const labels = Object.values(choiceMap);
    // pending優先、なければ自動候補
    const autoLabel = choiceMap[rawValue] ?? "";
    const selectedLabel = pending ? pending.label : autoLabel;

    const options = labels.map(label =>
      `<option value="${_esc(label)}"${label === selectedLabel ? " selected" : ""}>${_esc(label)}</option>`
    ).join("");

    let statusClass, statusText;
    if (pending) {
      statusClass = "unmatched-status-pending";
      statusText = "適用待ち";
    } else if (autoLabel) {
      statusClass = "unmatched-status-suggested";
      statusText = "候補あり";
    } else {
      statusClass = "unmatched-status-unset";
      statusText = "未設定";
    }

    return `
      <tr data-idx="${idx}" data-qcode="${_esc(qcode)}" data-rawval="${_esc(rawValue)}">
        <td>${_esc(qcode)}</td>
        <td><code class="unmatched-raw-value">${_esc(rawValue)}</code></td>
        <td style="text-align:right">${u.count.toLocaleString("ja-JP")}</td>
        <td>
          <select class="unmatched-label-select">
            <option value="">（変換しない）</option>
            ${options}
          </select>
        </td>
        <td style="width:86px">
          <span class="unmatched-status ${statusClass}">${statusText}</span>
        </td>
        <td style="width:56px;text-align:center">
          <button class="unmatched-apply-btn" type="button">適用</button>
        </td>
      </tr>`;
  }).join("");

  const pendingCount = Object.keys(_pendingFixes).length;
  el.innerHTML = `
    <p class="text-sm text-muted" style="margin-bottom:10px">
      変換先ラベルを選択すると「適用待ち」として保持されます。「一括適用」でまとめて登録できます。
    </p>
    <div class="unmatched-bulk-bar">
      <span class="unmatched-pending-count">${pendingCount > 0 ? `適用待ち ${pendingCount}件` : "適用待ちなし"}</span>
      <button class="unmatched-bulk-btn" type="button"${pendingCount === 0 ? " disabled" : ""}>一括適用</button>
    </div>
    <table class="unmatched-fix-table">
      <thead>
        <tr>
          <th>設問コード</th>
          <th>値</th>
          <th style="text-align:right">件数</th>
          <th>変換先ラベル</th>
          <th style="width:86px">状態</th>
          <th style="width:56px"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // changeデリゲーション: ドロップダウン選択を即時 _pendingFixes に保存
  _unmatchedChangeHandler = (e) => {
    const select = e.target.closest(".unmatched-label-select");
    if (!select) return;
    const row = select.closest("tr");
    if (!row) return;
    const qcode = row.dataset.qcode;
    const rawVal = row.dataset.rawval;
    const key = _pendingKey(qcode, rawVal);
    const label = select.value;

    if (label) {
      _pendingFixes[key] = { question_code: qcode, raw_value: rawVal, label };
    } else {
      delete _pendingFixes[key];
    }

    // 状態バッジを即時更新
    const statusEl = row.querySelector(".unmatched-status");
    if (statusEl) {
      if (label) {
        statusEl.className = "unmatched-status unmatched-status-pending";
        statusEl.textContent = "適用待ち";
      } else {
        const autoL = (AppState.step2Codebook?.[qcode] ?? {})[rawVal] ?? "";
        statusEl.className = `unmatched-status ${autoL ? "unmatched-status-suggested" : "unmatched-status-unset"}`;
        statusEl.textContent = autoL ? "候補あり" : "未設定";
      }
    }

    _updateBulkBarCount(el);
  };
  el.addEventListener("change", _unmatchedChangeHandler);

  // クリックデリゲーション
  _unmatchedClickHandler = async (e) => {
    const applyBtn = e.target.closest(".unmatched-apply-btn");
    const bulkBtn  = e.target.closest(".unmatched-bulk-btn");
    if (!applyBtn && !bulkBtn) return;

    if (applyBtn) {
      const row = applyBtn.closest("tr");
      const fix = _collectRowFix(row);
      if (!fix) { showToast("変換先ラベルを選択してください。", true); return; }
      await _applyLabelFixes([fix]);
    } else if (bulkBtn) {
      const fixes = Object.values(_pendingFixes);
      if (!fixes.length) { showToast("適用待ちの修正がありません。", true); return; }
      await _applyLabelFixes(fixes);
    }
  };
  el.addEventListener("click", _unmatchedClickHandler);
}

function _collectRowFix(row) {
  const qcode   = row.dataset.qcode;
  const rawVal  = row.dataset.rawval;
  const select  = row.querySelector(".unmatched-label-select");
  const label   = select?.value;
  if (!label) return null;
  return { question_code: qcode, raw_value: rawVal, label };
}

async function _applyLabelFixes(fixes) {
  if (!AppState.sessionToken) return;
  showSpinner("ラベル修正を適用中…");
  try {
    const result = await applyLabelFix(AppState.sessionToken, fixes);

    // 適用済みアイテムを pending から除去
    for (const fix of fixes) {
      delete _pendingFixes[_pendingKey(fix.question_code, fix.raw_value)];
    }

    const remaining     = result.remaining_unmatched ?? [];
    const labeledPreview = result.labeled_preview_rows ?? [];

    // _currentResp を更新
    if (_currentResp) {
      _currentResp.unmatched_values      = remaining;
      _currentResp.labeled_preview_rows  = labeledPreview;
    }
    AppState.step2UnmatchedValues      = remaining;
    AppState.step2LabeledPreviewRows   = labeledPreview;

    // 変換不可値テーブル再描画
    _renderUnmatchedTable("step2-preview-unmatched", remaining);

    // ラベル変換済みプレビュー再描画
    _labeledRows = labeledPreview;
    _applyColSearch();

    // 一致状況バッジ更新（変換不可値カウント）
    if (_currentResp) renderMatchCard(_currentResp);

    const msg = result.applied_count > 0
      ? `${result.applied_count} 件の変換不可値を修正しました。`
      : "修正を適用しました。";
    showToast(msg);
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

// ---------------------------------------------------------------------------
// タブ切り替え
// ---------------------------------------------------------------------------

function _activateTab(tabName) {
  const tabBar = document.getElementById("step2-preview-tabs");
  if (!tabBar) return;
  tabBar.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabName));
  ["raw", "labeled", "unmatched"].forEach(t => {
    const el = document.getElementById(`step2-preview-${t}`);
    if (el) el.style.display = t === tabName ? "" : "none";
  });
}

function _updateUnmatchedMeta(count) {
  const tabBtn = document.getElementById("tab-btn-unmatched");
  if (tabBtn) tabBtn.textContent = count > 0 ? `変換不可値（${count}）` : "変換不可値";

  const warning = document.getElementById("step2-unmatched-warning");
  if (warning) {
    const countEl = document.getElementById("step2-unmatched-warning-count");
    if (countEl) countEl.textContent = count;
    warning.style.display = count > 0 ? "" : "none";
  }
}

function _initTabSwitcher() {
  const tabBar = document.getElementById("step2-preview-tabs");
  tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    _activateTab(btn.dataset.tab);
  });
}

// ---------------------------------------------------------------------------
// ラベル変換済みデータ CSV エクスポート
// ---------------------------------------------------------------------------

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
// FA 一覧カード
// ---------------------------------------------------------------------------

const _faState = {
  faColumns:          [],
  _msQuestion:        null,
  hasData:            false,
  validatedStep1Axes: [],
  _pendingFaCodes:    [],
  _pendingAttrCols:   [],
};

function _initFaCard() {
  document.getElementById("fa-apply-btn").addEventListener("click", () => {
    const faCodes  = _faState._msQuestion?.getSelected() ?? [];
    const attrCols = _getAttrSelected();
    if (!faCodes.length) {
      showToast("FA設問を1つ以上選択してください。", true);
      return;
    }
    // FA設定をキャッシュに永続化（fire-and-forget）
    if (AppState.sessionToken) {
      saveFaSettings(AppState.sessionToken, faCodes, attrCols).catch(console.warn);
      setStep2FaCodes(faCodes);
    }
    _loadFaData(_collectFaParams());
  });

  document.getElementById("fa-reselect-axis-btn")?.addEventListener("click", () => {
    activatePanel("questions");
  });

  document.getElementById("fa-attr-deselect-all")?.addEventListener("click", () => {
    document.querySelectorAll('#fa-attr-cb-list input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
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
    _faState.faColumns = meta.fa_columns ?? [];
    setStep2FaMeta(meta);
    _initMultiSelects(meta);

    // プロジェクト読込時: 保留中の FA 選択を復元する
    if (_faState._pendingFaCodes?.length) {
      _faState._msQuestion?.setSelected(_faState._pendingFaCodes);
      _faState._pendingFaCodes = [];
    }
    if (_faState._pendingAttrCols?.length) {
      const pending = new Set(_faState._pendingAttrCols);
      document.querySelectorAll('#fa-attr-cb-list input[type="checkbox"]').forEach(cb => {
        cb.checked = pending.has(cb.value);
      });
      _faState._pendingAttrCols = [];
    }
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

function _initMultiSelects(meta) {
  // FA設問 multi-select
  const faOptions = (meta.fa_columns ?? []).map(col => ({
    value: col.question_code,
    label: `${col.question_code}｜${col.question_text}`,
    badge: col.type_label,
  }));
  _faState._msQuestion = new FaMultiSelect("fa-question-ms", faOptions, {
    placeholder: "FA設問を検索・選択…",
  });

  // 付与属性列: STEP1 集計軸以外の候補のみ
  _renderExtraAttrCheckboxes(meta.attr_candidates ?? []);
  _updateSortAttrSelect();
}

function _renderExtraAttrCheckboxes(attrCandidates) {
  const candidateMap = new Map(attrCandidates.map(c => [c.question_code, c]));
  const options = _faState.validatedStep1Axes.map(code => {
    const info = candidateMap.get(code);
    return { value: code, label: info ? `${code}　${info.question_text}` : code };
  });
  _renderAttrCheckboxes(options);
}

function _updateAttrMultiSelect() {
  const options = AppState.step2AxisCandidates.map(c => ({
    value: c.question_code,
    label: `${c.question_code}　${c.question_text}`,
  }));
  _renderAttrCheckboxes(options);
}

function _renderAttrCheckboxes(options) {
  const container = document.getElementById("fa-attr-cb-list");
  if (!container) return;
  const prevSelected = new Set(_getAttrSelected());
  const ctrlEl = document.getElementById("fa-attr-cb-ctrl");
  if (!options.length) {
    container.innerHTML = '<span class="text-sm text-muted">追加属性列の候補がありません</span>';
    if (ctrlEl) ctrlEl.style.display = "none";
    return;
  }
  const defaultAll = prevSelected.size === 0;
  container.innerHTML = options.map(o => `
    <label class="fa-attr-cb-item">
      <input type="checkbox" value="${_esc(o.value)}" ${(defaultAll || prevSelected.has(o.value)) ? "checked" : ""}>
      <span>${_esc(o.label)}</span>
    </label>
  `).join("");
  if (ctrlEl) ctrlEl.style.display = "";
}

function _getAttrSelected() {
  return Array.from(
    document.querySelectorAll('#fa-attr-cb-list input[type="checkbox"]:checked')
  ).map(el => el.value);
}

function _updateSortAttrSelect() {
  const sel = document.getElementById("fa-sort-attr-select");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = AppState.step2AxisCandidates.map(c => {
    const label = `${c.question_code}　${c.question_text}`;
    return `<option value="${_esc(c.question_code)}" ${c.question_code === cur ? "selected" : ""}>${_esc(label)}</option>`;
  }).join("");
}

function _collectFaParams() {
  return {
    attrColumns: _getAttrSelected(),
    faCodes:      _faState._msQuestion?.getSelected() ?? [],
    excludeEmpty: document.getElementById("fa-exclude-empty").checked,
    minChars:     parseInt(document.getElementById("fa-min-chars").value, 10) || 0,
    sortBy:       document.getElementById("fa-sort-select").value,
    sortAttr:     document.getElementById("fa-sort-attr-select").value || "",
    keyword:      document.getElementById("fa-keyword").value.trim(),
  };
}

async function _loadFaData(params) {
  if (!AppState.sessionToken) return;
  showSpinner("自由回答を読み込み中…");
  try {
    const data = await getFaData(AppState.sessionToken, params);
    _faState.hasData = true;

    document.getElementById("step2-fa-card").style.display = "";
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

  const attrCols = rows.length > 0 ? Object.keys(rows[0].attr_values) : [];

  const thead = `<tr>
    <th style="width:48px; text-align:right">RowID</th>
    ${attrCols.map(c => `<th style="white-space:nowrap">${_esc(c)}</th>`).join("")}
    <th style="width:90px; white-space:nowrap">設問コード</th>
    <th style="min-width:160px">質問文</th>
    <th style="min-width:240px">回答本文</th>
    <th style="width:56px; text-align:right">文字数</th>
  </tr>`;

  const tbody = rows.map((r) => {
    const rowStyle = r.is_empty ? ' style="opacity:0.45"' : '';
    const answerCell = r.is_empty
      ? `<td class="fa-answer-cell text-muted" style="font-style:italic">（空欄）</td>`
      : `<td class="fa-answer-cell">${_esc(r.answer)}</td>`;
    return `
    <tr${rowStyle}>
      <td style="text-align:right; color:var(--color-text-muted)">${r.row_index + 1}</td>
      ${attrCols.map(c => `<td class="text-sm">${_esc(r.attr_values[c] ?? "")}</td>`).join("")}
      <td class="text-sm"><strong>${_esc(r.question_code)}</strong></td>
      <td class="text-sm text-muted">${_esc(r.question_text)}</td>
      ${answerCell}
      <td class="fa-chars-cell text-sm">${r.char_count}</td>
    </tr>
  `;
  }).join("");

  wrap.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function _updateFaCountBar(data) {
  const bar = document.getElementById("fa-count-bar");
  const fmt = n => n.toLocaleString("ja-JP");
  const excludeEmpty = document.getElementById("fa-exclude-empty").checked;
  const emptyCount = data.empty_row_count ?? 0;

  if (excludeEmpty && emptyCount > 0) {
    bar.textContent = `有効 ${fmt(data.filtered_row_count)} 件 / 全 ${fmt(data.total_fa_rows)} 件（空欄 ${fmt(emptyCount)} 件）`;
  } else if (data.total_fa_rows === data.filtered_row_count + emptyCount) {
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

  /** 外部から選択状態を一括更新する */
  setSelected(codes) {
    this._selected = new Set(codes);
    this._renderTags();
    if (this._els) this._renderOptions(this._els.search?.value ?? "");
  }

  /** 選択肢を差し替える（現在の選択値のうち新選択肢にないものは除去） */
  updateOptions(newOptions) {
    this._allOptions = newOptions;
    this._selected = new Set([...this._selected].filter(v => newOptions.some(o => o.value === v)));
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

// ---------------------------------------------------------------------------
// プロジェクト読込: STEP2 状態復元
// ---------------------------------------------------------------------------

/**
 * AppState に格納済みの STEP2 データを使って UI を再描画する。
 * プロジェクト読込後にヘッダーから呼び出される。
 */
export function restoreStep2FromState() {
  const s = AppState;
  // STEP1 で確定済みの調査形式を固定表示に反映
  setResponseFormatRadio(s.surveyFormat);
  if (!s.step2Filename) return;

  // AppState から疑似 resp オブジェクトを構築（preview 行は空欄のまま）
  const resp = {
    filename:              s.step2Filename,
    encoding_detected:     s.step2Encoding,
    file_size:             s.step2FileSize,
    response_row_count:    s.step2RowCount,
    response_col_count:    s.step2ColCount,
    preview_rows:          [],
    labeled_preview_rows:  [],
    matched_columns:       s.step2MatchedColumns,
    missing_columns:       s.step2MissingColumns,
    extra_columns:         s.step2ExtraColumns,
    codebook:              s.step2Codebook,
    axis_candidates:       s.step2AxisCandidates,
    unmatched_values:      s.step2UnmatchedValues,
    multi_select_columns:  s.step2MultiSelectColumns,
    bracket_columns:       [],
    missing_column_details: [],
  };

  _renderAll(resp);

  // FA 選択を _loadFaMeta 完了後に復元するよう pending にセット
  _faState._pendingFaCodes  = s.step2SelectedFaCodes?.length  ? [...s.step2SelectedFaCodes]  : [];
  _faState._pendingAttrCols = s.step2SelectedAttrColumns?.length ? [...s.step2SelectedAttrColumns] : [];
}

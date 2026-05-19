/**
 * 設問一覧パネルの制御（テーブル描画・検索・フィルタ・軸/属性フラグ編集）。
 */
import { getQuestions, saveProject, loadProject, saveStep1AxisSettings } from "./api.js";
import { AppState, setFilterState, setStep1AxisCodes, resetState, setLoadedProject, setProjectName, markClean, markDirty } from "./state.js";
import { showToast, showError, showSpinner, hideSpinner, activatePanel } from "./app.js";
import { handleCsvFile, reloadLastCsvFile } from "./upload.js";

const AXIS_TYPE_CODES = new Set(["SA", "S", "NU", "N", "ML"]);

// 種別バッジスタイル
const TYPE_BADGE = {
  SA: { cls: "badge-SA",  label: "単一回答" },
  MA: { cls: "badge-MA",  label: "複数回答" },
  FA: { cls: "badge-FA",  label: "自由回答" },
  NU: { cls: "badge-NU",  label: "数値" },
  ML: { cls: "badge-ML",  label: "マトリクスループ" },
};

function typeBadge(typeCode, typeLabel) {
  const s = TYPE_BADGE[typeCode] ?? { cls: "badge-unknown", label: typeLabel || typeCode };
  return `<span class="badge ${s.cls}" title="${escHtml(typeCode)}">${escHtml(s.label)}</span>`;
}

let _debounceTimer = null;

function selectAllAxes() {
  const cbs = [...document.querySelectorAll("#questions-table .q-axis-cb")];
  const codes = [...AppState.step1AxisCodes];
  cbs.forEach(cb => {
    cb.checked = true;
    if (!codes.includes(cb.dataset.code)) codes.push(cb.dataset.code);
  });
  setStep1AxisCodes(codes);
}

function deselectAllAxes() {
  const cbs = [...document.querySelectorAll("#questions-table .q-axis-cb")];
  const visibleCodes = new Set(cbs.map(cb => cb.dataset.code));
  cbs.forEach(cb => { cb.checked = false; });
  setStep1AxisCodes(AppState.step1AxisCodes.filter(c => !visibleCodes.has(c)));
}

function setAxisCtrlVisible(visible) {
  const el = document.getElementById("q-axis-ctrl-top");
  if (el) el.style.display = visible ? "" : "none";
}

export function initQuestionsPanel() {
  const searchInput = document.getElementById("q-search");
  const typeSelect  = document.getElementById("q-type-filter");
  const childCheck  = document.getElementById("q-include-children");
  const applyBtn    = document.getElementById("q-apply-btn");

  searchInput.addEventListener("input", () => {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(applyFilters, 400);
  });
  typeSelect.addEventListener("change", applyFilters);
  childCheck.addEventListener("change", applyFilters);
  applyBtn.addEventListener("click", applyFilters);

  const table = document.getElementById("questions-table");

  // 選択肢「他◯件」展開 + 集計軸/属性チェックボックス（イベント委譲）
  table.addEventListener("click", (e) => {
    const btn = e.target.closest(".choice-more-btn");
    if (!btn) return;
    const list = btn.closest(".choice-list");
    const extra = list.querySelector(".choice-extra");
    const count = btn.dataset.extraCount;
    if (extra.hidden) {
      extra.hidden = false;
      btn.textContent = "▲ 折りたたむ";
    } else {
      extra.hidden = true;
      btn.textContent = `他${count}件を表示`;
    }
  });

  table.addEventListener("change", async (e) => {
    const cb = e.target;
    const code = cb.dataset.code;
    if (!code) return;

    if (cb.classList.contains("q-axis-cb")) {
      let cols = [...AppState.step1AxisCodes];
      if (cb.checked) { if (!cols.includes(code)) cols.push(code); }
      else { cols = cols.filter(c => c !== code); }
      setStep1AxisCodes(cols);
    }
  });

  // 全選択/全解除ボタン
  document.getElementById("q-select-all-top")?.addEventListener("click", selectAllAxes);
  document.getElementById("q-deselect-all-top")?.addEventListener("click", deselectAllAxes);

  // 集計軸を更新ボタン → Step2へ遷移
  document.getElementById("q-update-axis-btn")?.addEventListener("click", () => {
    activatePanel("step2");
  });

  // CSV情報カードのボタン
  document.getElementById("btn-csv-reload")?.addEventListener("click", async () => {
    await reloadLastCsvFile();
    applyFilters();
  });

  const replaceInput = document.getElementById("replace-csv-input");

  replaceInput?.addEventListener("change", async (e) => {
    if (e.target.files[0]) {
      await handleCsvFile(e.target.files[0]);
      applyFilters();
    }
    e.target.value = "";
  });

  const replaceDropZone = document.getElementById("csv-replace-drop-zone");
  if (replaceDropZone && replaceInput) {
    replaceDropZone.addEventListener("click", () => replaceInput.click());
    replaceDropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      replaceDropZone.classList.add("dragover");
    });
    replaceDropZone.addEventListener("dragleave", () =>
      replaceDropZone.classList.remove("dragover"));
    replaceDropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      replaceDropZone.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file) {
        await handleCsvFile(file);
        applyFilters();
      }
    });
  }

  document.getElementById("btn-csv-unload")?.addEventListener("click", () => {
    resetState();
    activatePanel("upload");
  });

  // 状態変化を監視して種別フィルターを更新
  document.addEventListener("survey:statechange", onStateChange);
}

function onStateChange() {
  updateCsvInfoCard();
  updateAxisSummary();
  if (AppState.activePanel !== "questions") return;
  updateTypeDropdown();
}

function updateCsvInfoCard() {
  const card = document.getElementById("csv-loaded-card");
  if (!card) return;
  if (!AppState.sessionToken || !AppState.sourceFilename) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  const dt = AppState.loadedAt
    ? AppState.loadedAt.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "–";
  document.getElementById("csv-loaded-info").innerHTML = `
    <div class="info-item"><span class="info-label">ファイル:</span><span class="info-value">${escHtml(AppState.sourceFilename)}</span></div>
    <div class="info-item"><span class="info-label">設問数:</span><span class="info-value">${AppState.rowCount} 件</span></div>
    <div class="info-item"><span class="info-label">読込日時:</span><span class="info-value">${dt}</span></div>
  `;
}

function updateAxisSummary() {
  const summary = document.getElementById("axis-summary");
  const badges  = document.getElementById("axis-summary-badges");
  if (!summary || !badges) return;
  const codes = AppState.step1AxisCodes;
  if (!codes.length) { summary.style.display = "none"; return; }
  summary.style.display = "flex";
  const qMap = new Map((AppState.questions ?? []).map(q => [q.question_code, q]));
  const MAX_SHOW = 5;
  const shown = codes.slice(0, MAX_SHOW);
  const rest  = codes.length - shown.length;
  badges.innerHTML =
    shown.map(c => {
      const q = qMap.get(c);
      const label = escHtml((q ? (q.question_text || q.stub || c) : c).slice(0, 8));
      return `<span class="badge" title="${escHtml(c)}">${label}</span>`;
    }).join("") +
    (rest > 0 ? `<span class="badge" style="background:var(--color-surface-2,#F8F8F8); color:var(--color-text-muted)">+${rest}</span>` : "");
}

export async function refreshQuestions() {
  if (!AppState.sessionToken) return;
  updateTypeDropdown();
  await applyFilters();
}

async function applyFilters() {
  if (!AppState.sessionToken) return;

  const search   = document.getElementById("q-search").value.trim();
  const typeFilter = document.getElementById("q-type-filter").value;
  const includeChildren = document.getElementById("q-include-children").checked;

  setFilterState({ searchText: search, typeFilter, includeChildren });

  try {
    const resp = await getQuestions(AppState.sessionToken, { search, typeFilter, includeChildren });
    renderTable(resp.questions, resp.total_count, resp.filtered_count);
  } catch (err) {
    showError(err.message);
  }
}

function updateTypeDropdown() {
  const select = document.getElementById("q-type-filter");
  const current = select.value;
  select.innerHTML = `<option value="">すべての種別</option>`;
  for (const code of AppState.allTypeCodes) {
    const info = TYPE_BADGE[code];
    const label = info ? `${info.label} (${code})` : code;
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    if (code === current) opt.selected = true;
    select.appendChild(opt);
  }
}

const CHOICE_LIMIT = 5;

function buildChoiceCell(choices) {
  if (choices.length === 0) {
    return `<span class="no-choice">選択肢なし</span>`;
  }
  const toTags = (list) =>
    list.map((c) => `<span class="choice-tag">${escHtml(c.choice_text)}</span>`).join(" ");

  if (choices.length <= CHOICE_LIMIT) {
    return `<div class="choice-list">${toTags(choices)}</div>`;
  }
  const rest = choices.length - CHOICE_LIMIT;
  return `<div class="choice-list">
    ${toTags(choices.slice(0, CHOICE_LIMIT))}
    <span class="choice-extra" hidden>${toTags(choices.slice(CHOICE_LIMIT))}</span>
    <button class="choice-more-btn" data-extra-count="${rest}">他${rest}件を表示</button>
  </div>`;
}

function renderTable(questions, totalCount, filteredCount) {
  const tbody = document.querySelector("#questions-table tbody");
  const countBar = document.getElementById("questions-count-bar");

  // has_children=true の親設問は一覧に表示しない（内部保持のみ）
  const displayRows = questions.filter((q) => !q.has_children);

  if (displayRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--color-text-muted)">該当する設問がありません。</td></tr>`;
    countBar.textContent = `0件表示 / 全${totalCount}件`;
    setAxisCtrlVisible(false);
    return;
  }

  countBar.textContent = `${displayRows.length}件表示 / 全${totalCount}件`;

  const axisSelected = new Set(AppState.step1AxisCodes);
  let hasAxisCb = false;

  tbody.innerHTML = displayRows.map((q, i) => {
    const rowCls  = q.is_child ? "row-child" : "";
    const codeCls = "code-cell" + (q.is_child ? " is-child" : "");

    const questionText = q.is_child ? (q.parent_text || q.question_text) : q.question_text;
    const stubText     = q.is_child ? (q.stub || q.question_text) : (q.stub || "");

    const hasAxis = AXIS_TYPE_CODES.has((q.type_code ?? "").toUpperCase());
    if (hasAxis) hasAxisCb = true;
    const axisCell = hasAxis
      ? `<td style="text-align:center"><input type="checkbox" class="q-axis-cb" data-code="${escHtml(q.question_code)}" ${axisSelected.has(q.question_code) ? "checked" : ""}></td>`
      : `<td></td>`;

    return `
      <tr class="${rowCls}">
        ${axisCell}
        <td>${i + 1}</td>
        <td class="${codeCls}">${escHtml(q.question_code)}</td>
        <td>${typeBadge(q.type_code, q.type_label)}</td>
        <td><span class="text-truncate" title="${escHtml(questionText)}">${escHtml(questionText)}</span></td>
        <td><span class="text-truncate" title="${escHtml(stubText)}">${escHtml(stubText)}</span></td>
        <td>${buildChoiceCell(q.choices)}</td>
      </tr>`;
  }).join("");

  setAxisCtrlVisible(hasAxisCb);
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// ヘッダー: プロジェクト管理
// ---------------------------------------------------------------------------

export function initProjectHeader() {
  // プロジェクト名変更ボタン
  document.getElementById("btn-rename-project")?.addEventListener("click", () => {
    const newName = prompt("プロジェクト名を入力してください:", AppState.projectName || "");
    if (newName !== null) {
      setProjectName(newName.trim());
      markDirty();
    }
  });

  // 新規プロジェクトボタン
  document.getElementById("btn-new-project")?.addEventListener("click", () => {
    if (AppState.isDirty) {
      if (!confirm("未保存の変更があります。新規プロジェクトを作成しますか？")) return;
    }
    resetState();
    activatePanel("upload");
  });

  // ヘッダーの読込ファイル入力
  const headerLoadInput = document.getElementById("project-load-input");
  headerLoadInput?.addEventListener("change", async () => {
    const file = headerLoadInput.files[0];
    if (!file) return;
    headerLoadInput.value = "";
    await _doLoadProject(file);
  });

  // 保存ボタン
  document.getElementById("btn-save-project")?.addEventListener("click", async () => {
    if (!AppState.sessionToken) {
      showToast("先にレイアウトファイルを読み込んでください。");
      return;
    }
    try {
      await saveStep1AxisSettings(AppState.sessionToken, AppState.step1AxisCodes);
      await saveProject(AppState.sessionToken, AppState.projectName);
      markClean(new Date());
      showToast("プロジェクトを保存しました。");
    } catch (err) {
      showError(err.message);
    }
  });

  // 状態変化でヘッダーを更新
  document.addEventListener("survey:statechange", _updateHeader);
  _updateHeader();
}

async function _doLoadProject(file) {
  showSpinner("プロジェクトを復元中…");
  try {
    const resp = await loadProject(file);
    setLoadedProject(resp);

    const warnings = [...(resp.load_warnings ?? [])];
    if (warnings.length) {
      showToast(warnings[0]);
    }

    if (resp.has_step2) {
      document.dispatchEvent(new CustomEvent("survey:projectloaded", { detail: resp }));
    } else {
      activatePanel("questions");
    }
    showToast("プロジェクトを復元しました。");
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

function _updateHeader() {
  const nameEl   = document.getElementById("header-project-name");
  const statusEl = document.getElementById("header-save-status");
  const lastEl   = document.getElementById("header-last-saved");

  if (nameEl) {
    nameEl.textContent = AppState.projectName || "未設定";
  }

  const hasSession = !!AppState.sessionToken;

  if (statusEl) {
    statusEl.style.display = hasSession ? "" : "none";
    if (AppState.isDirty) {
      statusEl.textContent = "● 未保存";
      statusEl.className   = "header-save-status header-save-unsaved";
    } else {
      statusEl.textContent = "✓ 保存済み";
      statusEl.className   = "header-save-status header-save-saved";
    }
  }

  if (lastEl) {
    if (AppState.projectSavedAt) {
      const dt = AppState.projectSavedAt.toLocaleString("ja-JP", {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      lastEl.textContent   = `最終保存: ${dt}`;
      lastEl.style.display = "";
    } else {
      lastEl.style.display = "none";
    }
  }
}

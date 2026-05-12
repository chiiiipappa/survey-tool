/**
 * 設問一覧パネルの制御（テーブル描画・検索・フィルタ・JSONビューア）。
 */
import { getQuestions, getQuestionsJson, saveProject } from "./api.js";
import { AppState, setFilterState } from "./state.js";
import { showToast, showError, showSpinner, hideSpinner } from "./app.js";

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

  // 選択肢の「他◯件を表示」展開ボタン（イベント委譲）
  document.getElementById("questions-table").addEventListener("click", (e) => {
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

  // JSON ビューア toggle
  document.getElementById("json-viewer-toggle").addEventListener("click", toggleJsonViewer);
  document.getElementById("json-copy-btn").addEventListener("click", copyJson);
  document.getElementById("json-load-btn").addEventListener("click", loadJson);

  // プロジェクト保存ボタン
  document.getElementById("btn-save-project")?.addEventListener("click", async () => {
    if (!AppState.sessionToken) return;
    try {
      await saveProject(AppState.sessionToken);
      showToast("プロジェクトを保存しました。");
    } catch (err) {
      showError(err.message);
    }
  });

  // 状態変化を監視して種別フィルターを更新
  document.addEventListener("survey:statechange", onStateChange);
}

function onStateChange() {
  if (AppState.activePanel !== "questions") return;
  updateTypeDropdown();
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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:32px; color:var(--color-text-muted)">該当する設問がありません。</td></tr>`;
    countBar.textContent = `0件表示 / 全${totalCount}件`;
    return;
  }

  countBar.textContent = `${displayRows.length}件表示 / 全${totalCount}件`;

  tbody.innerHTML = displayRows.map((q, i) => {
    const rowCls = q.is_child ? "row-child" : "";
    const codeCls = "code-cell" + (q.is_child ? " is-child" : "");

    // 子設問: 質問文=親Title、表側=子自身のTitle
    //   日本語形式CSV: stub に子の固有テキストあり → stub 優先
    //   CQT形式: stub が空のため question_text にフォールバック
    // 通常設問: 質問文=自身のTitle、表側=stub（CSV由来、通常空）
    const questionText = q.is_child ? (q.parent_text || q.question_text) : q.question_text;
    const stubText     = q.is_child ? (q.stub || q.question_text) : (q.stub || "");

    return `
      <tr class="${rowCls}">
        <td>${i + 1}</td>
        <td class="${codeCls}">${escHtml(q.question_code)}</td>
        <td>${typeBadge(q.type_code, q.type_label)}</td>
        <td><span class="text-truncate" title="${escHtml(questionText)}">${escHtml(questionText)}</span></td>
        <td><span class="text-truncate" title="${escHtml(stubText)}">${escHtml(stubText)}</span></td>
        <td>${buildChoiceCell(q.choices)}</td>
      </tr>`;
  }).join("");
}

// --- JSON ビューア ---
let _jsonCache = null;

async function loadJson() {
  if (!AppState.sessionToken) return;
  showSpinner("JSON を取得中…");
  try {
    const resp = await getQuestionsJson(AppState.sessionToken);
    _jsonCache = JSON.stringify(resp.questions, null, 2);
    document.getElementById("json-pre").textContent = _jsonCache;
    openJsonViewer();
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

function toggleJsonViewer() {
  const body = document.getElementById("json-viewer-body");
  const isOpen = body.classList.toggle("open");
  document.getElementById("json-viewer-toggle").textContent =
    isOpen ? "▲ JSON ビューアを閉じる" : "▼ JSON ビューアを開く（内部データ確認）";
  if (isOpen && !_jsonCache) loadJson();
}

function openJsonViewer() {
  const body = document.getElementById("json-viewer-body");
  body.classList.add("open");
  document.getElementById("json-viewer-toggle").textContent = "▲ JSON ビューアを閉じる";
}

async function copyJson() {
  if (!_jsonCache) await loadJson();
  if (!_jsonCache) return;
  try {
    await navigator.clipboard.writeText(_jsonCache);
    showToast("JSON をコピーしました。");
  } catch {
    showError("クリップボードへのコピーに失敗しました。");
  }
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

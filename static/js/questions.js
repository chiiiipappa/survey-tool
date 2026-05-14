/**
 * 設問一覧パネルの制御（テーブル描画・検索・フィルタ・軸/属性フラグ編集）。
 */
import { getQuestions, saveProject, saveStep2Axis } from "./api.js";
import { AppState, setFilterState, setStep2AxisSelection, setStep2AttrSelection } from "./state.js";
import { showToast, showError } from "./app.js";

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
      let cols = [...AppState.step2SelectedAxisColumns];
      if (cb.checked) { if (!cols.includes(code)) cols.push(code); }
      else { cols = cols.filter(c => c !== code); }
      setStep2AxisSelection(cols);
      try {
        await saveStep2Axis(AppState.sessionToken, cols);
      } catch (err) {
        showError(err.message);
      }
    }

    if (cb.classList.contains("q-attr-cb")) {
      let cols = [...AppState.step2SelectedAttrColumns];
      if (cb.checked) { if (!cols.includes(code)) cols.push(code); }
      else { cols = cols.filter(c => c !== code); }
      setStep2AttrSelection(cols);
    }
  });

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
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:32px; color:var(--color-text-muted)">該当する設問がありません。</td></tr>`;
    countBar.textContent = `0件表示 / 全${totalCount}件`;
    return;
  }

  countBar.textContent = `${displayRows.length}件表示 / 全${totalCount}件`;

  const axisSet     = new Set(AppState.step2AxisCandidates.map(c => c.question_code));
  const attrSet     = new Set(AppState.step2AttrCandidates.map(c => c.question_code));
  const axisSelected = new Set(AppState.step2SelectedAxisColumns);
  const attrSelected = new Set(AppState.step2SelectedAttrColumns);
  const hasStep2    = AppState.step2AxisCandidates.length > 0;

  tbody.innerHTML = displayRows.map((q, i) => {
    const rowCls  = q.is_child ? "row-child" : "";
    const codeCls = "code-cell" + (q.is_child ? " is-child" : "");

    const questionText = q.is_child ? (q.parent_text || q.question_text) : q.question_text;
    const stubText     = q.is_child ? (q.stub || q.question_text) : (q.stub || "");

    const axisCell = hasStep2 && axisSet.has(q.question_code)
      ? `<td style="text-align:center"><input type="checkbox" class="q-axis-cb" data-code="${escHtml(q.question_code)}" ${axisSelected.has(q.question_code) ? "checked" : ""}></td>`
      : `<td></td>`;
    const attrCell = hasStep2 && attrSet.has(q.question_code)
      ? `<td style="text-align:center"><input type="checkbox" class="q-attr-cb" data-code="${escHtml(q.question_code)}" ${attrSelected.has(q.question_code) ? "checked" : ""}></td>`
      : `<td></td>`;

    return `
      <tr class="${rowCls}">
        <td>${i + 1}</td>
        <td class="${codeCls}">${escHtml(q.question_code)}</td>
        <td>${typeBadge(q.type_code, q.type_label)}</td>
        <td><span class="text-truncate" title="${escHtml(questionText)}">${escHtml(questionText)}</span></td>
        <td><span class="text-truncate" title="${escHtml(stubText)}">${escHtml(stubText)}</span></td>
        <td>${buildChoiceCell(q.choices)}</td>
        ${axisCell}
        ${attrCell}
      </tr>`;
  }).join("");
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

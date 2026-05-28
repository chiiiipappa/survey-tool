/**
 * 設問一覧パネルの制御（テーブル描画・検索・フィルタ・軸/属性フラグ編集）。
 */
import { getQuestions, saveProject, loadProject, saveStep1AxisSettings } from "./api.js";
import { AppState, setFilterState, setStep1AxisCodes, resetState, setLoadedProject, setProjectName, markClean, markDirty, setStep1FixedPalette, clearStep1FixedPalette, addUserPalette, deleteUserPalette, setQuestionSets, setStep3ActiveSetId, setExcludedQuestionCodes } from "./state.js";
import { getCrosstabCache, setCrosstabCache } from "./step3.js";
import { showToast, showError, showSpinner, hideSpinner, activatePanel } from "./app.js";
import { handleCsvFile, reloadLastCsvFile } from "./upload.js";

const AXIS_TYPE_CODES = new Set(["SA", "S", "NU", "N", "ML"]);

// STEP1 一覧で初期非表示にする question_type（「補助列も表示」チェックなし時）
const AUX_QUESTION_TYPES = new Set(["OA_AUX", "FLAG", "DERIVED"]);

const FIXED_PALETTE_LABELS = {
  fan_label:  "ファンラベル",
  gender:     "男女パレット",
  age_gender: "性年代パレットA",
  age_a:      "年代別パレットA",
  age_b:      "年代別パレットB",
  age_c:      "年代別パレットC",
  scale_67:   "6〜7段階",
  scale_1011: "10〜11段階",
};
const FIXED_PALETTE_PREVIEWS = {
  fan_label:  ["#FF5050","#FF9999","#FFCCCC","#BFBFBF"],
  gender:     ["#1D4ED8","#DB2777"],
  age_gender: ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A","#FBCFE8","#F9A8D4","#F472B6","#EC4899","#DB2777","#9D174D"],
  age_a:      ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
  age_b:      ["#D1FAE5","#A7F3D0","#6EE7B7","#34D399","#10B981","#065F46"],
  age_c:      ["#FEF3C7","#FDE68A","#FCD34D","#FBBF24","#F59E0B","#B45309"],
  scale_67:   ["#9D174D","#EC4899","#F9A8D4","#D9D9D9","#93C5FD","#3B82F6","#1E3A8A"],
  scale_1011: ["#9D174D","#DB2777","#EC4899","#F472B6","#F9A8D4","#D9D9D9","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
};
const DEFAULT_COLORS_PREVIEW = ["#4299E1","#F6AD55","#68D391","#F687B3","#9F7AEA"];
const FIXED_PALETTE_ORDER_Q = ["fan_label","gender","age_gender","age_a","age_b","age_c","scale_67","scale_1011"];

// ---------------------------------------------------------------------------
// 設問セット 自動推定・管理
// ---------------------------------------------------------------------------

const _FA_TYPES = new Set(["FA","OA","OE","FT","FN"]);

// STEP3 デフォルト表示対象の question_type
const STEP3_DEFAULT_TYPES = new Set(["SA","MA","MATRIX","NUMERIC","WEIGHT","ATTRIBUTE","UNKNOWN"]);

function _getRootPrefix(q, qMap, visited = new Set()) {
  if (visited.has(q.question_code)) {
    return q.question_code.match(/^([A-Za-z]+\d+)/)?.[1] ?? q.question_code;
  }
  visited.add(q.question_code);
  if (q.parent_code && qMap[q.parent_code]) {
    return _getRootPrefix(qMap[q.parent_code], qMap, visited);
  }
  return q.question_code.match(/^([A-Za-z]+\d+)/)?.[1] ?? q.question_code;
}

const _AUTO_SKIP_TYPES = new Set(["OA_TEXT", "OA_AUX", "FLAG", "DERIVED", "WEIGHT"]);

export function autoDetectQuestionSets(questions, excludedCodes = []) {
  if (!questions || questions.length === 0) return [];
  const excluded = new Set(excludedCodes);
  const qMap = Object.fromEntries(questions.map(q => [q.question_code, q]));

  const groups = new Map();
  for (const q of questions) {
    const qt = q.question_type ?? "UNKNOWN";
    if (_AUTO_SKIP_TYPES.has(qt)) continue;
    if (q.has_children) continue;
    if (excluded.has(q.question_code)) continue;

    const prefix = _getRootPrefix(q, qMap);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(q.question_code);
  }

  return Array.from(groups.entries())
    .filter(([, codes]) => codes.length > 0)
    .map(([prefix, codes]) => ({
      setId: `auto_${prefix.toLowerCase()}`,
      setName: `${prefix}系`,
      questionCodes: codes,
      isCustom: false,
      isParent: false,
      children: [],
    }));
}

function _maybeAutoDetect() {
  if (AppState.questions.length > 0 && AppState.questionSets.length === 0) {
    setQuestionSets(autoDetectQuestionSets(AppState.questions, AppState.excludedQuestionCodes));
  }
}

function _getSetQuestionCount(s) {
  if (s.isParent) {
    return (s.children ?? []).reduce((sum, c) => sum + (c.questionCodes?.length ?? 0), 0);
  }
  return s.questionCodes?.length ?? 0;
}

function _renderSetSummary() {
  const card = document.getElementById("step1-set-card");
  const summary = document.getElementById("step1-set-summary");
  if (!card || !summary) return;

  if (!AppState.sessionToken || AppState.questionSets.length === 0) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  const sets = AppState.questionSets;
  const totalQ = sets.reduce((sum, s) => sum + _getSetQuestionCount(s), 0);
  const names = sets.slice(0, 3).map(s => `「${escHtml(s.setName)}」`).join("");
  const more = sets.length > 3 ? `ほか${sets.length - 3}セット` : "";
  summary.innerHTML = `<span style="font-size:.85rem; color:var(--color-text-muted)">${names}${more} / 計${totalQ}問</span>`;
}

// ---------------------------------------------------------------------------
// 設問セット管理モーダル
// ---------------------------------------------------------------------------

let _setEditingId = null;
let _allQuestionsForCreate = null;
let _editingInitialName  = "";
let _editingInitialCodes = new Set();

function _initSetModal() {
  const modal    = document.getElementById("step1-set-modal");
  const closeBtn = document.getElementById("step1-set-modal-close");
  if (!modal) return;

  closeBtn?.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", e => { if (e.target === modal) modal.hidden = true; });

  // エディタの表示/非表示
  const _showEditor = (show) => {
    const editor = document.getElementById("step1-set-editor");
    const empty  = document.getElementById("step1-set-editor-empty");
    if (editor) editor.style.display = show ? "block" : "none";
    if (empty)  empty.style.display  = show ? "none"  : "block";
  };

  // 「初期状態に戻す」ボタン → 自動生成状態に戻す
  document.getElementById("step1-set-regenerate-btn")?.addEventListener("click", () => {
    if (!confirm("現在の集計セット編集内容を破棄し、自動生成された初期状態に戻します。よろしいですか？")) return;
    setQuestionSets(autoDetectQuestionSets(AppState.questions, AppState.excludedQuestionCodes));
    _setEditingId = null;
    _showEditor(false);
    _refreshSetList();
    _renderSetSummary();
  });

  // 編集内容が変更されているか判定
  const _isDirty = () => {
    const name  = document.getElementById("step1-set-name-input")?.value ?? "";
    const codes = _getCheckedCodes();
    if (name !== _editingInitialName) return true;
    if (codes.size !== _editingInitialCodes.size) return true;
    for (const c of codes) { if (!_editingInitialCodes.has(c)) return true; }
    return false;
  };

  // 変更を破棄（編集中 → データ再ロード、新規 → エディタ非表示）
  const _discardChanges = () => {
    if (_isDirty() && !confirm("変更内容を保存せず破棄しますか？")) return;
    if (_setEditingId) {
      _refreshSetCreatePanel();
    } else {
      _showEditor(false);
    }
  };

  // 「変更を破棄」ボタン
  document.getElementById("step1-set-cancel-btn")?.addEventListener("click", _discardChanges);

  // セットを保存
  document.getElementById("step1-set-create-btn")?.addEventListener("click", _saveSet);

  // 全選択 / 全解除
  document.getElementById("step1-set-select-all-btn")?.addEventListener("click", () => {
    document.querySelectorAll(".analysis-set-q-cb").forEach(cb => { cb.checked = true; });
    _syncSelectedList();
  });
  document.getElementById("step1-set-deselect-all-btn")?.addEventListener("click", () => {
    document.querySelectorAll(".analysis-set-q-cb").forEach(cb => { cb.checked = false; });
    _syncSelectedList();
  });

  document.getElementById("step1-set-q-list")?.addEventListener("change", e => {
    if (e.target.classList.contains("analysis-set-q-cb")) _syncSelectedList();
  });

  document.getElementById("step1-set-selected-list")?.addEventListener("click", e => {
    const removeBtn = e.target.closest("[data-remove]");
    if (!removeBtn) return;
    const code = removeBtn.dataset.remove;
    const cb = document.querySelector(`.analysis-set-q-cb[data-code="${CSS.escape(code)}"]`);
    if (cb) cb.checked = false;
    _syncSelectedList();
  });

  let _searchTimer = null;
  document.getElementById("step1-set-q-search")?.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(_filterSetQList, 300);
  });


  // 「＋ 新規セット作成」ボタン
  document.getElementById("step1-set-new-btn")?.addEventListener("click", () => {
    _setEditingId = null;
    _refreshSetList();
    _refreshSetCreatePanel();
    _showEditor(true);
  });

  // 削除確認モーダル
  const _deleteModal   = document.getElementById("step1-set-delete-modal");
  const _deleteCancelBtn  = document.getElementById("step1-set-delete-cancel");
  const _deleteConfirmBtn = document.getElementById("step1-set-delete-confirm");
  let _pendingDeleteId = null;

  function _showDeleteModal(setId) {
    _pendingDeleteId = setId;
    if (_deleteModal) _deleteModal.hidden = false;
  }
  function _hideDeleteModal() {
    _pendingDeleteId = null;
    if (_deleteModal) _deleteModal.hidden = true;
  }
  _deleteCancelBtn?.addEventListener("click", _hideDeleteModal);
  _deleteModal?.addEventListener("click", e => { if (e.target === _deleteModal) _hideDeleteModal(); });
  _deleteConfirmBtn?.addEventListener("click", () => {
    const id = _pendingDeleteId;
    _hideDeleteModal();
    if (!id) return;
    if (_setEditingId === id) {
      _setEditingId = null;
      _showEditor(false);
    }
    setQuestionSets(AppState.questionSets.filter(s => s.setId !== id));
    _refreshSetList();
    _renderSetSummary();
  });

  // サイドバーのイベント委譲
  document.getElementById("step1-set-sidebar-nav")?.addEventListener("click", e => {
    const delBtn  = e.target.closest("[data-set-delete]");
    if (delBtn) {
      e.stopPropagation();
      _showDeleteModal(delBtn.dataset.setDelete);
      return;
    }

    // nav アイテムクリック → セット選択＋エディタ表示
    const navItem = e.target.closest(".step3-nav-item");
    if (navItem) {
      const setId = navItem.dataset.setId;
      if (setId) {
        _setEditingId = setId;
        _refreshSetList();
        _refreshSetCreatePanel();
        _showEditor(true);
      }
    }
  });

  document.getElementById("btn-manage-sets")?.addEventListener("click", () => {
    const sets = AppState.questionSets;
    if (sets.length > 0) {
      _setEditingId = sets[0].setId;
      _refreshSetCreatePanel();
      _showEditor(true);
    } else {
      _setEditingId = null;
      _showEditor(false);
    }
    _refreshSetList();
    modal.hidden = false;
  });
}

function _refreshSetList() {
  const nav = document.getElementById("step1-set-sidebar-nav");
  if (!nav) return;

  const sets = AppState.questionSets;
  if (sets.length === 0) {
    nav.innerHTML = `<div class="step3-nav-empty">集計セットがありません。<br>「新規集計セット作成」から追加できます。</div>`;
    return;
  }

  const qMap    = Object.fromEntries(AppState.questions.map(q => [q.question_code, q]));
  const excluded = new Set(AppState.excludedQuestionCodes);

  nav.innerHTML = sets.map(s => {
    const qCount    = _getSetQuestionCount(s);
    const isExcl    = s.isExcluded === true;
    const isActive  = s.setId === _setEditingId;
    const firstCode = s.questionCodes?.find(c => !excluded.has(c)) ?? s.questionCodes?.[0];
    const firstQ    = firstCode ? qMap[firstCode] : null;
    const descText  = firstQ?.parent_text || firstQ?.question_text || "";
    const sid = escHtml(s.setId);
    return `
      <div class="step3-nav-item${isActive ? " active" : ""}${isExcl ? " step3-nav-item-excluded" : ""}"
           data-set-id="${sid}">
        <span class="step3-nav-dot-placeholder"></span>
        <div class="step3-nav-item-body">
          <div class="step3-nav-item-header">
            <span class="step3-nav-item-name">${escHtml(s.setName)}</span>
            <span class="step3-nav-item-count">(${qCount})</span>
            ${isExcl ? `<span class="step1-set-excluded-badge">除外</span>` : ""}
          </div>
          ${descText ? `<div class="step3-nav-item-desc">${escHtml(descText)}</div>` : ""}
        </div>
        <button class="step1-set-delete-btn" data-set-delete="${sid}" title="削除">×</button>
      </div>`;
  }).join("");
}

function _refreshSetCreatePanel() {
  const _excluded = new Set(AppState.excludedQuestionCodes);
  _allQuestionsForCreate = AppState.questions.filter(q =>
    !q.has_children && !_excluded.has(q.question_code)
  );

  const nameInput   = document.getElementById("step1-set-name-input");
  const searchInput = document.getElementById("step1-set-q-search");
  const titleEl     = document.getElementById("step1-set-tab-custom-title");
  if (searchInput) searchInput.value = "";

  if (_setEditingId) {
    const set = AppState.questionSets.find(s => s.setId === _setEditingId);
    if (set) {
      if (nameInput) nameInput.value = set.setName;
      if (titleEl)   titleEl.textContent = "集計セットを編集";
      const editCodes = new Set(set.questionCodes ?? []);
      _editingInitialName  = set.setName;
      _editingInitialCodes = new Set(set.questionCodes ?? []);
      _renderQList(_allQuestionsForCreate, editCodes);
      _syncSelectedList();
      return;
    }
  }

  // 新規作成モード
  _editingInitialName  = "";
  _editingInitialCodes = new Set();
  if (nameInput) nameInput.value = "";
  if (titleEl)   titleEl.textContent = "新規集計セット作成";
  _renderQList(_allQuestionsForCreate, new Set());
  const selectedList = document.getElementById("step1-set-selected-list");
  if (selectedList) selectedList.innerHTML =
    `<p class="analysis-set-empty-right">左の一覧から設問を選択してください。</p>`;
  _updateSelectedCount();
}

function _renderQList(questions, initialCheckedCodes = null) {
  const listEl = document.getElementById("step1-set-q-list");
  if (!listEl) return;

  const normalQs = questions.filter(q => q.question_type !== "OA_TEXT");
  const oaQs     = questions.filter(q => q.question_type === "OA_TEXT");

  if (!normalQs.length && !oaQs.length) {
    listEl.innerHTML = `<p class="analysis-set-empty">該当する設問がありません。</p>`;
    return;
  }

  const checkedCodes = initialCheckedCodes ?? _getCheckedCodes();
  const renderRow = (q) => {
    const shortText = (q.question_text ?? "").slice(0, 28);
    return `<label class="analysis-set-q-row">
      <input type="checkbox" class="analysis-set-q-cb" data-code="${escHtml(q.question_code)}"
             ${checkedCodes.has(q.question_code) ? "checked" : ""}>
      <span class="analysis-set-q-code">${escHtml(q.question_code)}</span>
      <span class="analysis-set-q-text" title="${escHtml(q.question_text ?? "")}">${escHtml(shortText)}</span>
    </label>`;
  };

  let html = normalQs.map(renderRow).join("");
  if (oaQs.length) {
    html += `<div class="analysis-set-oa-header">自由回答（FA分析用）</div>`;
    html += oaQs.map(renderRow).join("");
  }
  listEl.innerHTML = html;
}

function _getCheckedCodes() {
  const codes = new Set();
  document.querySelectorAll(".analysis-set-q-cb:checked")
    .forEach(cb => codes.add(cb.dataset.code));
  return codes;
}

function _syncSelectedList() {
  const selectedList = document.getElementById("step1-set-selected-list");
  if (!selectedList) return;
  const checkedCodes = _getCheckedCodes();
  const ordered = (_allQuestionsForCreate ?? [])
    .filter(q => checkedCodes.has(q.question_code))
    .map(q => q.question_code);
  selectedList.innerHTML = ordered.length === 0
    ? `<p class="analysis-set-empty-right">左の一覧から設問を選択してください。</p>`
    : ordered.map(code => `
        <div class="analysis-set-selected-row">
          <span class="analysis-set-q-code">${escHtml(code)}</span>
          <button class="btn btn-secondary btn-sm" data-remove="${escHtml(code)}"
                  style="margin-left:auto; padding:1px 6px">✕</button>
        </div>`).join("");
  _updateSelectedCount();
}

function _updateSelectedCount() {
  const el = document.getElementById("step1-set-selected-count");
  if (el) el.textContent = `${_getCheckedCodes().size}問選択中`;
}

function _filterSetQList() {
  if (!_allQuestionsForCreate) return;
  const q = (document.getElementById("step1-set-q-search")?.value ?? "").trim().toLowerCase();
  const filtered = !q
    ? _allQuestionsForCreate
    : _allQuestionsForCreate.filter(x =>
        x.question_code.toLowerCase().includes(q) ||
        (x.question_text ?? "").toLowerCase().includes(q)
      );
  _renderQList(filtered);
}

function _saveSet() {
  const name = document.getElementById("step1-set-name-input")?.value.trim();
  if (!name) { alert("セット名を入力してください。"); return; }

  const selected = (_allQuestionsForCreate ?? [])
    .filter(q => _getCheckedCodes().has(q.question_code))
    .map(q => q.question_code);

  if (_setEditingId) {
    setQuestionSets(AppState.questionSets.map(s =>
      s.setId !== _setEditingId ? s : {
        ...s, setName: name, questionCodes: selected, isCustom: true,
      }
    ));
    _editingInitialName  = name;
    _editingInitialCodes = new Set(selected);
  } else {
    if (selected.length === 0) { alert("設問を1つ以上選択してください。"); return; }
    const newId = `set_${Date.now()}`;
    setQuestionSets([...AppState.questionSets, {
      setId: newId, setName: name,
      questionCodes: selected, isCustom: true, isParent: false, children: [],
    }]);
    _setEditingId = newId;
  }

  _refreshSetList();
  _renderSetSummary();
}

// STEP1 パレット管理モーダル用
let _step1PaletteTargetAxis = null;

function _s1HexToHsl(hex) {
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h = 0, s = 0;
  const l = (max+min)/2;
  if (max !== min) {
    const d = max-min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch (max) {
      case r: h = ((g-b)/d+(g<b?6:0))/6; break;
      case g: h = ((b-r)/d+2)/6; break;
      case b: h = ((r-g)/d+4)/6; break;
    }
  }
  return [h, s, l];
}
function _s1HslToHex(h, s, l) {
  const hue2rgb = (p,q,t) => { if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l<0.5?l*(1+s):l+s-l*s, p = 2*l-q;
    r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);
  }
  const toHex = v => Math.round(v*255).toString(16).padStart(2,"0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function _s1GeneratePaletteColors(keyHex, count, stepPct, pattern, finePct, satAdjPct) {
  const [h, s, l] = _s1HexToHsl(keyHex);
  const step = stepPct/100, fine = finePct/100;
  const sAdj = Math.min(1, Math.max(0, s + satAdjPct/100));
  const clampL = v => Math.min(0.95, Math.max(0.05, v));
  let lightnesses;
  if (pattern === "center") {
    const ci = Math.floor(count/2);
    lightnesses = Array.from({length:count}, (_,i) => clampL(l+(ci-i)*step+fine));
  } else if (pattern === "light_to_dark") {
    lightnesses = Array.from({length:count}, (_,i) => clampL(l-i*step+fine));
  } else {
    lightnesses = Array.from({length:count}, (_,i) => clampL(l-(count-1-i)*step+fine));
  }
  return lightnesses.map(lv => _s1HslToHex(h, sAdj, lv));
}

// 種別バッジスタイル（type_code）
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

// 分析用分類バッジスタイル（question_type）
const QUESTION_TYPE_BADGE = {
  SA:        { cls: "badge-qtype-SA",        label: "SA" },
  MA:        { cls: "badge-qtype-MA",        label: "MA" },
  MATRIX:    { cls: "badge-qtype-MATRIX",    label: "MATRIX" },
  NUMERIC:   { cls: "badge-qtype-NUMERIC",   label: "NUMERIC" },
  OA_TEXT:   { cls: "badge-qtype-OA_TEXT",   label: "OA" },
  OA_AUX:    { cls: "badge-qtype-OA_AUX",    label: "OA補助" },
  WEIGHT:    { cls: "badge-qtype-WEIGHT",    label: "WEIGHT" },
  ATTRIBUTE: { cls: "badge-qtype-ATTRIBUTE", label: "属性" },
  FLAG:      { cls: "badge-qtype-FLAG",      label: "FLAG" },
  DERIVED:   { cls: "badge-qtype-DERIVED",   label: "派生" },
  UNKNOWN:   { cls: "badge-qtype-UNKNOWN",   label: "?" },
};

function questionTypeBadge(questionType) {
  const s = QUESTION_TYPE_BADGE[questionType] ?? QUESTION_TYPE_BADGE.UNKNOWN;
  return `<span class="badge ${s.cls}" title="${escHtml(questionType)}">${escHtml(s.label)}</span>`;
}

let _debounceTimer = null;

// _currentDisplayRows は仮想スクロール対応の全選択/全解除で使う
let _currentDisplayRows = [];

function selectAllAxes() {
  const codes = [...AppState.step1AxisCodes];
  for (const q of _currentDisplayRows) {
    if (AXIS_TYPE_CODES.has((q.type_code ?? "").toUpperCase())) {
      if (!codes.includes(q.question_code)) codes.push(q.question_code);
    }
  }
  setStep1AxisCodes(codes);
}

function deselectAllAxes() {
  const displayCodes = new Set(
    _currentDisplayRows
      .filter(q => AXIS_TYPE_CODES.has((q.type_code ?? "").toUpperCase()))
      .map(q => q.question_code)
  );
  setStep1AxisCodes(AppState.step1AxisCodes.filter(c => !displayCodes.has(c)));
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
  document.getElementById("q-show-aux")?.addEventListener("change", applyFilters);
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

  // STEP1 固定パレット変更
  document.getElementById("step1-axis-color-body")?.addEventListener("change", e => {
    const sel = e.target.closest(".step1-axis-palette-select");
    if (!sel) return;
    const axisCode = sel.dataset.axis;
    const val = sel.value;
    if (val === "__auto__") {
      clearStep1FixedPalette(axisCode);
    } else if (val === "__none__") {
      setStep1FixedPalette(axisCode, "__none__");
    } else {
      setStep1FixedPalette(axisCode, val);
    }
    const previewEl = document.querySelector(`[data-axis-preview="${CSS.escape(axisCode)}"]`);
    if (previewEl) {
      let colors;
      if (val === "__none__") {
        colors = ["#676767"];
      } else if (val === "__auto__") {
        const autoKey = _detectFixedPaletteFromQuestion(axisCode);
        colors = autoKey === "__none__" ? ["#676767"]
          : (FIXED_PALETTE_PREVIEWS[autoKey] ?? DEFAULT_COLORS_PREVIEW);
      } else {
        colors = FIXED_PALETTE_PREVIEWS[val] ?? AppState.userPalettes?.[val]?.generatedColors ?? DEFAULT_COLORS_PREVIEW;
      }
      previewEl.innerHTML = colors.map(c => `<span style="background:${c}"></span>`).join("");
    }
  });

  // STEP1 パレット 新規作成 / 編集ボタン
  document.getElementById("step1-axis-color-body")?.addEventListener("click", e => {
    const newBtn  = e.target.closest(".step1-palette-new-btn");
    const editBtn = e.target.closest(".step1-palette-edit-btn");
    if (newBtn)  { _step1PaletteTargetAxis = newBtn.dataset.axis;  _openStep1PaletteModal("create"); }
    if (editBtn) { _step1PaletteTargetAxis = editBtn.dataset.axis; _openStep1PaletteModal("edit"); }
  });

  _initStep1PaletteModal();
  _initSetModal();
}

function onStateChange() {
  updateCsvInfoCard();
  updateAxisSummary();
  updateAxisColorSection();
  _maybeAutoDetect();
  _renderSetSummary();
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

function _detectFixedPaletteFromQuestion(code) {
  const q = (AppState.questions ?? []).find(q => q.question_code === code);
  if (!q) return "__none__";
  const text = (q.question_text ?? "") + (q.stub ?? "");
  if (/[*＊]ファンラベル/.test(text) || /ファン度/.test(text) ||
      /FAN_LEVEL/i.test(code) || /SKFAN/i.test(code)) return "fan_label";
  // テキストベース検出（軸名・質問文を優先）
  if (/性年代|性×年代|男女年代|性年代別/.test(text)) return "age_gender";
  if (/性別|男女/.test(text)) return "gender";
  if (/年代|年齢/.test(text)) return "age_c";
  // 選択肢ベース検出
  const labels = (q.choices ?? []).map(c => c.choice_text ?? "");
  if (labels.some(l => /コアファン/.test(l)) && labels.some(l => /ライトファン/.test(l))) return "fan_label";
  if (labels.some(l => /(男性|女性)\d+代/.test(l)) || labels.some(l => /\d+代(男性|女性)/.test(l))) return "age_gender";
  if (labels.some(l => /^男($|性)/.test(l)) || labels.some(l => /^女($|性)/.test(l))) return "gender";
  if (labels.some(l => /\d+代/.test(l)) || labels.some(l => /\d+[-~〜]\d+歳/.test(l))) return "age_c";
  if (labels.some(l => /High[1-5]|TOP[23]/.test(l)) && labels.some(l => /Low[1-5]/.test(l)))
    return labels.length > 7 ? "scale_1011" : "scale_67";
  return "__none__";
}

function updateAxisColorSection() {
  const card = document.getElementById("step1-axis-color-card");
  const body = document.getElementById("step1-axis-color-body");
  if (!card || !body) return;
  const codes = AppState.step1AxisCodes;
  if (!codes.length) { card.style.display = "none"; return; }
  card.style.display = "";

  const qMap = new Map((AppState.questions ?? []).map(q => [q.question_code, q]));
  body.innerHTML = codes.map(code => {
    const q = qMap.get(code);
    const labelText = escHtml(q ? (q.question_text || q.stub || code) : code);
    const entry      = AppState.step1AxisColors?.[code];
    const isExplicit = entry && "fixedPalette" in entry;
    const autoKey    = _detectFixedPaletteFromQuestion(code);
    const selectedKey = isExplicit ? entry.fixedPalette : autoKey;

    const previewColors = selectedKey === "__none__"
      ? ["#676767"]
      : selectedKey
        ? (FIXED_PALETTE_PREVIEWS[selectedKey] ?? AppState.userPalettes?.[selectedKey]?.generatedColors ?? DEFAULT_COLORS_PREVIEW)
        : DEFAULT_COLORS_PREVIEW;
    const swatches = previewColors.map(c => `<span style="background:${c}"></span>`).join("");

    const autoLabel = autoKey === "__none__"
      ? "自動（グレー）"
      : `自動（${FIXED_PALETTE_LABELS[autoKey] ?? autoKey}）`;
    const userPalettes = Object.values(AppState.userPalettes ?? {});
    const isCustomPalette = isExplicit && selectedKey && !FIXED_PALETTE_ORDER_Q.includes(selectedKey) && selectedKey !== "__none__";
    const options = [
      `<option value="__auto__"${!isExplicit ? " selected" : ""}>${escHtml(autoLabel)}</option>`,
      ...FIXED_PALETTE_ORDER_Q.map(key =>
        `<option value="${key}"${isExplicit && selectedKey === key ? " selected" : ""}>${escHtml(FIXED_PALETTE_LABELS[key])}</option>`
      ),
      ...userPalettes.map(p =>
        `<option value="${escHtml(p.paletteId)}"${isExplicit && selectedKey === p.paletteId ? " selected" : ""}>${escHtml(p.paletteName)}</option>`
      ),
      `<option value="__none__"${isExplicit && selectedKey === "__none__" ? " selected" : ""}>なし（グレー・単色）</option>`,
    ].join("");

    return `
      <div class="step1-axis-color-row" data-axis="${escHtml(code)}">
        <span class="step1-axis-color-label">${labelText}
          <span style="font-size:.78rem; color:var(--color-text-muted)">(${escHtml(code)})</span>
        </span>
        <select class="step1-axis-palette-select" data-axis="${escHtml(code)}">${options}</select>
        <div class="step1-axis-palette-swatches" data-axis-preview="${escHtml(code)}">${swatches}</div>
        <button class="btn btn-secondary btn-sm step1-palette-new-btn" data-axis="${escHtml(code)}">＋ 新規作成</button>
        <button class="btn btn-secondary btn-sm step1-palette-edit-btn" data-axis="${escHtml(code)}"${isCustomPalette ? "" : " hidden"}>✎ 編集</button>
      </div>`;
  }).join("");
}

// ===== STEP1 パレット管理モーダル =====

function _openStep1PaletteModal(mode) {
  const modal = document.getElementById("step1-palette-modal");
  if (!modal) return;
  const createPanel = document.getElementById("step1-create-panel");
  const editPanel   = document.getElementById("step1-edit-panel");
  modal.hidden = false;
  if (mode === "edit") {
    createPanel.hidden = true;
    editPanel.hidden   = false;
    document.querySelectorAll(".step1-palette-tab").forEach(t => {
      t.classList.toggle("step1-palette-tab-active", t.dataset.tab === "edit");
      t.className = t.dataset.tab === "edit" ? "btn btn-primary btn-sm step1-palette-tab step1-palette-tab-active" : "btn btn-secondary btn-sm step1-palette-tab";
    });
    _refreshStep1EditPanel();
  } else {
    createPanel.hidden = false;
    editPanel.hidden   = true;
    document.querySelectorAll(".step1-palette-tab").forEach(t => {
      t.className = t.dataset.tab === "create" ? "btn btn-primary btn-sm step1-palette-tab step1-palette-tab-active" : "btn btn-secondary btn-sm step1-palette-tab";
    });
    _updateStep1GenPreview();
  }
}

function _updateStep1GenPreview() {
  const keyColor = document.getElementById("step1-gen-key-color")?.value ?? "#0071BC";
  const count    = parseInt(document.getElementById("step1-gen-count")?.value ?? "6", 10);
  const stepPct  = parseInt(document.getElementById("step1-gen-brightness-step")?.value ?? "10", 10);
  const pattern  = document.getElementById("step1-gen-pattern")?.value ?? "center";
  const finePct  = parseInt(document.getElementById("step1-gen-brightness-fine")?.value ?? "0", 10);
  const satPct   = parseInt(document.getElementById("step1-gen-saturation")?.value ?? "0", 10);
  const colors   = _s1GeneratePaletteColors(keyColor, count, stepPct, pattern, finePct, satPct);
  const preview  = document.getElementById("step1-gen-preview");
  if (preview) preview.innerHTML = colors.map(c => `<span class="step3-gen-preview-chip" style="background:${c}" title="${c}"></span>`).join("");
  return colors;
}

function _buildStep1PaletteEntry(colors) {
  const keyColor = document.getElementById("step1-gen-key-color")?.value ?? "#0071BC";
  const count    = parseInt(document.getElementById("step1-gen-count")?.value ?? "6", 10);
  const stepPct  = parseInt(document.getElementById("step1-gen-brightness-step")?.value ?? "10", 10);
  const pattern  = document.getElementById("step1-gen-pattern")?.value ?? "center";
  const finePct  = parseInt(document.getElementById("step1-gen-brightness-fine")?.value ?? "0", 10);
  const satPct   = parseInt(document.getElementById("step1-gen-saturation")?.value ?? "0", 10);
  const rawName  = (document.getElementById("step1-gen-name")?.value ?? "").trim();
  const name     = rawName || `${keyColor}_${count}色`;
  return {
    paletteId:          `custom_${Date.now()}`,
    paletteName:        name,
    keyColor,
    generatedColors:    colors,
    colorCount:         count,
    brightnessStepPct:  stepPct,
    brightnessPattern:  pattern,
    brightnessFinePct:  finePct,
    satAdjPct:          satPct,
    createdAt:          new Date().toISOString(),
  };
}

function _refreshStep1EditPanel() {
  const sel = document.getElementById("step1-edit-palette-select");
  if (!sel) return;
  const palettes = Object.values(AppState.userPalettes ?? {});
  if (!palettes.length) {
    sel.innerHTML = `<option value="">（カスタムパレットなし）</option>`;
    document.getElementById("step1-edit-colors-area").innerHTML = "";
    return;
  }
  sel.innerHTML = palettes.map(p => `<option value="${escHtml(p.paletteId)}">${escHtml(p.paletteName)}</option>`).join("");
  _renderStep1EditColors(sel.value);
}

function _renderStep1EditColors(paletteId) {
  const area = document.getElementById("step1-edit-colors-area");
  if (!area) return;
  const entry = AppState.userPalettes?.[paletteId];
  if (!entry) { area.innerHTML = ""; return; }
  area.innerHTML = entry.generatedColors.map((c, i) => `
    <div class="step1-edit-color-chip" data-idx="${i}">
      <input type="color" value="${c}" title="色 ${i+1}">
      <button class="step1-edit-remove-chip" data-idx="${i}" title="削除" style="background:none;border:none;cursor:pointer;font-size:.8rem;color:#999;">✕</button>
    </div>`).join("");
}

function _initStep1PaletteModal() {
  const modal = document.getElementById("step1-palette-modal");
  if (!modal) return;

  document.getElementById("step1-palette-close")?.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", e => { if (e.target === modal) modal.hidden = true; });

  // タブ切り替え
  modal.addEventListener("click", e => {
    const tab = e.target.closest(".step1-palette-tab");
    if (!tab) return;
    _openStep1PaletteModal(tab.dataset.tab === "edit" ? "edit" : "create");
  });

  // プレビュー更新
  const syncSlider = (inputId, valId) => {
    const input = document.getElementById(inputId);
    const valEl = document.getElementById(valId);
    input?.addEventListener("input", () => { if (valEl) valEl.textContent = input.value + "%"; _updateStep1GenPreview(); });
  };
  document.getElementById("step1-gen-key-color")?.addEventListener("input", e => {
    const hex = document.getElementById("step1-gen-key-color-hex");
    if (hex) hex.textContent = e.target.value;
    _updateStep1GenPreview();
  });
  document.getElementById("step1-gen-count")?.addEventListener("input", _updateStep1GenPreview);
  document.getElementById("step1-gen-pattern")?.addEventListener("change", _updateStep1GenPreview);
  syncSlider("step1-gen-brightness-step", "step1-gen-brightness-step-val");
  syncSlider("step1-gen-brightness-fine", "step1-gen-brightness-fine-val");
  syncSlider("step1-gen-saturation",      "step1-gen-saturation-val");

  // 保存のみ
  document.getElementById("step1-gen-save-btn")?.addEventListener("click", () => {
    const colors = _updateStep1GenPreview();
    if (!colors.length) return;
    addUserPalette(_buildStep1PaletteEntry(colors));
    updateAxisColorSection();
    showToast("パレットを追加しました");
  });

  // 作成して適用
  document.getElementById("step1-gen-apply-btn")?.addEventListener("click", () => {
    const colors = _updateStep1GenPreview();
    if (!colors.length) return;
    const entry = _buildStep1PaletteEntry(colors);
    addUserPalette(entry);
    if (_step1PaletteTargetAxis) setStep1FixedPalette(_step1PaletteTargetAxis, entry.paletteId);
    updateAxisColorSection();
    modal.hidden = true;
    showToast("パレットを作成して適用しました");
  });

  // 編集パネル: パレット選択変更
  document.getElementById("step1-edit-palette-select")?.addEventListener("change", e => {
    _renderStep1EditColors(e.target.value);
  });

  // 編集パネル: 色チップ削除
  document.getElementById("step1-edit-colors-area")?.addEventListener("click", e => {
    const removeBtn = e.target.closest(".step1-edit-remove-chip");
    if (!removeBtn) return;
    const paletteId = document.getElementById("step1-edit-palette-select")?.value;
    const entry = AppState.userPalettes?.[paletteId];
    if (!entry) return;
    const idx = parseInt(removeBtn.dataset.idx, 10);
    const newColors = entry.generatedColors.filter((_, i) => i !== idx);
    addUserPalette({ ...entry, generatedColors: newColors });
    _renderStep1EditColors(paletteId);
  });

  // 編集パネル: 色追加
  document.getElementById("step1-edit-add-color")?.addEventListener("click", () => {
    const paletteId = document.getElementById("step1-edit-palette-select")?.value;
    const entry = AppState.userPalettes?.[paletteId];
    if (!entry) return;
    addUserPalette({ ...entry, generatedColors: [...entry.generatedColors, "#888888"] });
    _renderStep1EditColors(paletteId);
  });

  // 編集パネル: 変更を保存
  document.getElementById("step1-edit-save-btn")?.addEventListener("click", () => {
    const paletteId = document.getElementById("step1-edit-palette-select")?.value;
    const entry = AppState.userPalettes?.[paletteId];
    if (!entry) return;
    const chips = document.querySelectorAll("#step1-edit-colors-area .step1-edit-color-chip input[type=color]");
    const newColors = Array.from(chips).map(c => c.value);
    addUserPalette({ ...entry, generatedColors: newColors });
    updateAxisColorSection();
    showToast("パレットを更新しました");
  });

  // 編集パネル: 削除
  document.getElementById("step1-edit-delete-btn")?.addEventListener("click", () => {
    const paletteId = document.getElementById("step1-edit-palette-select")?.value;
    if (!paletteId) return;
    deleteUserPalette(paletteId);
    _refreshStep1EditPanel();
    updateAxisColorSection();
    showToast("パレットを削除しました");
  });
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

// ---------------------------------------------------------------------------
// 仮想スクロールテーブル
// ---------------------------------------------------------------------------

const VT_BUFFER = 15;      // 可視領域の上下に保持する余裕行数
const VT_ROW_HEIGHT = 48;  // 行の推定高さ(px)。初回レンダリング後に実測値で上書き

class _VirtualTable {
  constructor(scrollEl, tbody) {
    this._scrollEl = scrollEl;
    this._tbody = tbody;
    this._rows = [];
    this._buildFn = null;
    this._rowHeight = VT_ROW_HEIGHT;
    this._start = -1;
    this._end = -1;
    this._measured = false;

    this._topSpacer = this._makeSpacer();
    this._botSpacer = this._makeSpacer();
    tbody.appendChild(this._topSpacer);
    tbody.appendChild(this._botSpacer);

    this._onScroll = () => this._update();
    scrollEl.addEventListener("scroll", this._onScroll, { passive: true });
  }

  _makeSpacer() {
    const tr = document.createElement("tr");
    tr.className = "vt-spacer";
    const td = document.createElement("td");
    td.colSpan = 8;
    td.style.cssText = "padding:0;border:none;height:0";
    tr.appendChild(td);
    return tr;
  }

  render(rows, buildFn) {
    this._rows = rows;
    this._buildFn = buildFn;
    this._start = -1;
    this._end = -1;
    this._measured = false;
    this._scrollEl.scrollTop = 0;
    this._update();
  }

  _getViewport() {
    const scrollTop = this._scrollEl.scrollTop;
    const h = this._scrollEl.clientHeight || 560;
    const rh = this._rowHeight;
    const start = Math.max(0, Math.floor(scrollTop / rh) - VT_BUFFER);
    const end = Math.min(this._rows.length, Math.ceil((scrollTop + h) / rh) + VT_BUFFER);
    return { start, end };
  }

  _update() {
    if (!this._rows.length || !this._buildFn) return;
    const { start, end } = this._getViewport();
    if (start === this._start && end === this._end) return;

    this._start = start;
    this._end = end;
    const n = this._rows.length;
    const rh = this._rowHeight;

    this._topSpacer.firstChild.style.height = (start * rh) + "px";
    this._botSpacer.firstChild.style.height = Math.max(0, (n - end) * rh) + "px";

    // 旧可視行を削除
    const toRemove = [];
    for (const tr of this._tbody.children) {
      if (tr !== this._topSpacer && tr !== this._botSpacer) toRemove.push(tr);
    }
    toRemove.forEach(tr => tr.remove());

    // 新可視行を挿入
    let html = "";
    for (let i = start; i < end; i++) html += this._buildFn(this._rows[i], i);
    const temp = document.createElement("tbody");
    temp.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (temp.firstChild) frag.appendChild(temp.firstChild);
    this._tbody.insertBefore(frag, this._botSpacer);

    // 初回レンダリング後に実際の行高さを計測して精度を上げる
    if (!this._measured) {
      const sample = this._tbody.children[1];
      if (sample && sample.offsetHeight > 10) {
        this._rowHeight = sample.offsetHeight;
        this._measured = true;
        this._botSpacer.firstChild.style.height = Math.max(0, (n - end) * this._rowHeight) + "px";
      }
    }
  }

  showEmpty(html) {
    const toRemove = [];
    for (const tr of this._tbody.children) {
      if (tr !== this._topSpacer && tr !== this._botSpacer) toRemove.push(tr);
    }
    toRemove.forEach(tr => tr.remove());
    this._topSpacer.firstChild.style.height = "0";
    this._botSpacer.firstChild.style.height = "0";
    const temp = document.createElement("tbody");
    temp.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (temp.firstChild) frag.appendChild(temp.firstChild);
    this._tbody.insertBefore(frag, this._botSpacer);
  }

  destroy() {
    this._scrollEl.removeEventListener("scroll", this._onScroll);
  }
}

let _vt = null;

function renderTable(questions, totalCount, filteredCount) {
  const tbody    = document.querySelector("#questions-table tbody");
  const scrollEl = document.getElementById("questions-table-wrap");
  const countBar = document.getElementById("questions-count-bar");

  const showAux = document.getElementById("q-show-aux")?.checked ?? false;
  const displayRows = questions.filter((q) => {
    if (q.has_children) return false;
    if (!showAux && AUX_QUESTION_TYPES.has(q.question_type ?? "")) return false;
    return true;
  });

  _currentDisplayRows = displayRows;

  // 仮想テーブルを初回のみ生成（スクロールリスナーを使い回す）
  if (!_vt) {
    tbody.innerHTML = "";
    _vt = new _VirtualTable(scrollEl, tbody);
  }

  if (displayRows.length === 0) {
    _vt.showEmpty(
      `<tr><td colspan="8" style="text-align:center; padding:32px; color:var(--color-text-muted)">該当する設問がありません。</td></tr>`
    );
    countBar.textContent = `0件表示 / 全${totalCount}件`;
    setAxisCtrlVisible(false);
    return;
  }

  countBar.textContent = `${displayRows.length}件表示 / 全${totalCount}件`;

  const axisSelected = new Set(AppState.step1AxisCodes);
  let hasAxisCb = false;
  for (const q of displayRows) {
    if (AXIS_TYPE_CODES.has((q.type_code ?? "").toUpperCase())) { hasAxisCb = true; break; }
  }

  const buildRowHtml = (q, i) => {
    const rowCls  = q.is_child ? "row-child" : "";
    const codeCls = "code-cell" + (q.is_child ? " is-child" : "");
    const questionText = q.is_child ? (q.parent_text || q.question_text) : q.question_text;
    const stubText     = q.is_child ? (q.stub || q.question_text) : (q.stub || "");
    const hasAxis = AXIS_TYPE_CODES.has((q.type_code ?? "").toUpperCase());
    const axisCell = hasAxis
      ? `<td style="text-align:center"><input type="checkbox" class="q-axis-cb" data-code="${escHtml(q.question_code)}" ${axisSelected.has(q.question_code) ? "checked" : ""}></td>`
      : `<td></td>`;
    const qtBadge = questionTypeBadge(q.question_type ?? "UNKNOWN");
    return `
      <tr class="${rowCls}">
        ${axisCell}
        <td>${i + 1}</td>
        <td class="${codeCls}">${escHtml(q.question_code)}</td>
        <td>${typeBadge(q.type_code, q.type_label)}</td>
        <td>${qtBadge}</td>
        <td><span class="text-truncate" title="${escHtml(questionText)}">${escHtml(questionText)}</span></td>
        <td><span class="text-truncate" title="${escHtml(stubText)}">${escHtml(stubText)}</span></td>
        <td>${buildChoiceCell(q.choices)}</td>
      </tr>`;
  };

  _vt.render(displayRows, buildRowHtml);
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
      await saveStep1AxisSettings(AppState.sessionToken, AppState.step1AxisCodes, AppState.step3ActiveAxisCode);
      await saveProject(
        AppState.sessionToken,
        AppState.projectName,
        AppState.step3QuestionSettings,
        AppState.step1AxisColors,
        AppState.userPalettes,
        {
          secondaryAxisCode: AppState.step3SecondaryAxisCode,
          displayMode: AppState.step3CompositeDisplayMode,
          colorPriority: AppState.step3ColorPriority,
          minSampleSize: AppState.step3MinSampleSize,
        },
        AppState.questionSets,
        getCrosstabCache(),
        AppState.hiddenQuestionTypes,
        AppState.excludedQuestionCodes,
        AppState.step3Views,
      );
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
    setCrosstabCache(resp.layout?.step3_crosstab_cache ?? {});
    // 設問セットが空ならフォールバックで自動推定
    if ((resp.layout?.question_sets ?? []).length === 0 && (resp.layout?.questions ?? []).length > 0) {
      setQuestionSets(autoDetectQuestionSets(resp.layout.questions));
    }

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

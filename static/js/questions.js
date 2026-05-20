/**
 * 設問一覧パネルの制御（テーブル描画・検索・フィルタ・軸/属性フラグ編集）。
 */
import { getQuestions, saveProject, loadProject, saveStep1AxisSettings } from "./api.js";
import { AppState, setFilterState, setStep1AxisCodes, resetState, setLoadedProject, setProjectName, markClean, markDirty, setStep1FixedPalette, clearStep1FixedPalette, addUserPalette, deleteUserPalette } from "./state.js";
import { showToast, showError, showSpinner, hideSpinner, activatePanel } from "./app.js";
import { handleCsvFile, reloadLastCsvFile } from "./upload.js";

const AXIS_TYPE_CODES = new Set(["SA", "S", "NU", "N", "ML"]);

const FIXED_PALETTE_LABELS = {
  fan_label:  "ファンラベル",
  gender:     "男女パレット",
  age_gender: "性年代パレット",
  age_a:      "年代別パレットA",
  age_b:      "年代別パレットB",
  scale_67:   "6〜7段階",
  scale_1011: "10〜11段階",
};
const FIXED_PALETTE_PREVIEWS = {
  fan_label:  ["#FF5050","#FF9999","#FFCCCC","#BFBFBF"],
  gender:     ["#1D4ED8","#DB2777"],
  age_gender: ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A","#FBCFE8","#F9A8D4","#F472B6","#EC4899","#DB2777","#9D174D"],
  age_a:      ["#BFDBFE","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
  age_b:      ["#D1FAE5","#A7F3D0","#6EE7B7","#34D399","#10B981","#065F46"],
  scale_67:   ["#9D174D","#EC4899","#F9A8D4","#D9D9D9","#93C5FD","#3B82F6","#1E3A8A"],
  scale_1011: ["#9D174D","#DB2777","#EC4899","#F472B6","#F9A8D4","#D9D9D9","#93C5FD","#60A5FA","#3B82F6","#1D4ED8","#1E3A8A"],
};
const DEFAULT_COLORS_PREVIEW = ["#4299E1","#F6AD55","#68D391","#F687B3","#9F7AEA"];
const FIXED_PALETTE_ORDER_Q = ["fan_label","gender","age_gender","age_a","age_b","scale_67","scale_1011"];

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
      const colors = val === "__none__"
        ? ["#676767"]
        : val !== "__auto__"
          ? (FIXED_PALETTE_PREVIEWS[val] ?? AppState.userPalettes?.[val]?.generatedColors ?? DEFAULT_COLORS_PREVIEW)
          : DEFAULT_COLORS_PREVIEW;
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
}

function onStateChange() {
  updateCsvInfoCard();
  updateAxisSummary();
  updateAxisColorSection();
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
  if (!q) return null;
  const text = (q.question_text ?? "") + (q.stub ?? "");
  if (/[*＊]ファンラベル/.test(text) || /ファン度/.test(text) ||
      /FAN_LEVEL/i.test(code) || /SKFAN/i.test(code)) return "fan_label";
  const labels = (q.choices ?? []).map(c => c.choice_text ?? "");
  if (labels.some(l => /コアファン/.test(l)) && labels.some(l => /ライトファン/.test(l))) return "fan_label";
  if (labels.some(l => /\d+代(男性|女性)/.test(l))) return "age_gender";
  if (labels.some(l => /^男($|性)/.test(l)) || labels.some(l => /^女($|性)/.test(l))) return "gender";
  if (labels.some(l => /\d+代/.test(l))) return "age_a";
  if (labels.some(l => /High[1-5]|TOP[23]/.test(l)) && labels.some(l => /Low[1-5]/.test(l)))
    return labels.length > 7 ? "scale_1011" : "scale_67";
  return null;
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

    const autoLabel = autoKey ? `自動検出（${FIXED_PALETTE_LABELS[autoKey]}）` : "自動検出（なし）";
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

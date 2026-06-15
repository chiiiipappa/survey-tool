/**
 * アップロードパネルの制御。
 */
import { uploadFile, remapUpload, loadProject } from "./api.js";
import { setUploadResult, setLoadedProject } from "./state.js";
import { showToast, showError, showSpinner, hideSpinner, activatePanel } from "./app.js";

const CHOICE_MODE_LABEL = {
  multi_col:            "複数列（選択肢1, 選択肢2…）",
  single_col_delimited: "単一列（区切り文字）",
  none:                 "選択肢列なし",
};

const FORMAT_NAME = {
  standard:       "標準形式（コード/種別/質問文）",
  survey_company: "調査会社形式（回答タイプ/質問文A-B）",
  cqt:            "CQT 形式（Column/Question/Type）",
  manual:         "手動マッピング",
};

let _lastFile = null;

export function initUploadPanel() {
  // ブラウザのファイル保存ダイアログ抑制（ゾーン外ドロップ対策）
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  const dropZone     = document.getElementById("drop-zone");
  const fileInput    = document.getElementById("file-input");
  const projectInput = document.getElementById("project-input");

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleCsvFile(f);
  });

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (f) handleCsvFile(f);
  });

  // プロジェクト復元
  projectInput?.addEventListener("change", () => {
    if (projectInput.files[0]) handleProjectLoad(projectInput.files[0]);
    projectInput.value = "";
  });
}

export async function handleCsvFile(file) {
  const lname = file.name.toLowerCase();
  if (!lname.endsWith(".csv") && !lname.endsWith(".xlsx")) {
    showError("CSV (.csv) または Excel (.xlsx) ファイルを選択してください。");
    return;
  }
  _lastFile = file;
  const label = lname.endsWith(".xlsx") ? "Excel" : "CSV";
  showSpinner(`${label} を解析中…`);
  try {
    const resp = await uploadFile(file);
    if (resp.needs_manual_mapping) {
      _showManualMappingPanel(resp);
    } else {
      _onUploadSuccess(resp);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

export function reloadLastCsvFile() {
  if (_lastFile) return handleCsvFile(_lastFile);
}

function _onUploadSuccess(resp) {
  setUploadResult(resp);
  renderFileInfo(resp);
  _renderFormatDetectBox(resp);
  renderWarnings(resp.parse_warnings ?? []);
  document.getElementById("btn-to-questions").disabled = false;
  _hideManualMappingPanel();
  showToast(`${resp.row_count} 設問を読み込みました。`);
  activatePanel("questions");
}

function _renderFormatDetectBox(resp) {
  const box = document.getElementById("format-detect-box");
  if (!box) return;
  if (!resp.detected_format || resp.detected_format === "standard" || resp.detected_format === "cqt") {
    box.style.display = "none";
    return;
  }
  const fi = resp.format_info ?? {};
  const fmtName = FORMAT_NAME[resp.detected_format] ?? resp.detected_format;
  const choiceDesc = fi.choices?.length
    ? `${escHtml(fi.choices[0])}〜${escHtml(fi.choices[fi.choices.length - 1])} 列 (${fi.choices.length} 列)`
    : "—";
  const textDesc = [fi.text_a, fi.text_b].filter(Boolean).map(escHtml).join(" + ") || escHtml(fi.text || "—");

  box.style.display = "";
  box.innerHTML = `
    <div class="format-detect-title">レイアウト形式を自動判定しました</div>
    <table class="format-detect-table">
      <tr><td>形式</td><td>${escHtml(fmtName)}</td></tr>
      <tr><td>コード列</td><td>${escHtml(fi.code ?? "—")}</td></tr>
      <tr><td>種別列</td><td>${escHtml(fi.type ?? "—")}</td></tr>
      <tr><td>質問文</td><td>${textDesc}</td></tr>
      ${fi.choices?.length ? `<tr><td>選択肢</td><td>${choiceDesc}</td></tr>` : ""}
    </table>
    <p class="format-detect-hint">問題がなければ次へ進めます。</p>
  `;
}

function _showManualMappingPanel(resp) {
  const panel = document.getElementById("manual-mapping-panel");
  if (!panel) return;

  const cols = resp.available_columns ?? [];
  const noneOpt = `<option value="">— 列を選択 —</option>`;
  const colOpts = cols.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("");
  const optionalOpts = `<option value="">（省略）</option>` + colOpts;

  panel.querySelector("#mmap-code").innerHTML = noneOpt + colOpts;
  panel.querySelector("#mmap-type").innerHTML = noneOpt + colOpts;
  panel.querySelector("#mmap-text").innerHTML = noneOpt + colOpts;
  panel.querySelector("#mmap-text-sub").innerHTML = optionalOpts;
  panel.querySelector("#mmap-choices-from").innerHTML = optionalOpts;
  panel.querySelector("#mmap-choices-to").innerHTML = optionalOpts;

  // ファイル情報バーを最低限表示
  const bar = document.getElementById("file-info-bar");
  if (bar) {
    bar.classList.remove("hidden");
    bar.innerHTML = `
      <div class="info-item">
        <span class="info-label">ファイル:</span>
        <span class="info-value">${escHtml(resp.filename)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">列数:</span>
        <span class="info-value">${cols.length}</span>
      </div>
    `;
  }

  panel.style.display = "";
  document.getElementById("format-detect-box")?.style && (document.getElementById("format-detect-box").style.display = "none");

  const applyBtn = panel.querySelector("#mmap-apply-btn");
  // クリーンアップ: 古いリスナーを削除
  const newBtn = applyBtn.cloneNode(true);
  applyBtn.parentNode.replaceChild(newBtn, applyBtn);

  newBtn.addEventListener("click", async () => {
    const colMapping = {
      code:         panel.querySelector("#mmap-code").value,
      type:         panel.querySelector("#mmap-type").value,
      text:         panel.querySelector("#mmap-text").value,
      text_sub:     panel.querySelector("#mmap-text-sub").value || null,
      choices_from: panel.querySelector("#mmap-choices-from").value || null,
      choices_to:   panel.querySelector("#mmap-choices-to").value || null,
    };
    if (!colMapping.code || !colMapping.type || !colMapping.text) {
      showError("コード列・種別列・質問文列は必須です。");
      return;
    }
    showSpinner("マッピングを適用中…");
    try {
      const remapped = await remapUpload(resp.session_token, colMapping);
      _onUploadSuccess(remapped);
    } catch (err) {
      showError(err.message);
    } finally {
      hideSpinner();
    }
  });
}

function _hideManualMappingPanel() {
  const panel = document.getElementById("manual-mapping-panel");
  if (panel) panel.style.display = "none";
}

async function handleProjectLoad(file) {
  showSpinner("プロジェクトを復元中…");
  try {
    const resp = await loadProject(file);
    setLoadedProject(resp);

    // ファイル情報バーを簡易表示
    const bar = document.getElementById("file-info-bar");
    bar.classList.remove("hidden");
    bar.innerHTML = `
      <div class="info-item">
        <span class="info-label">プロジェクト:</span>
        <span class="info-value">${escHtml(file.name)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">設問数:</span>
        <span class="info-value">${resp.questions.length}</span>
      </div>
    `;

    renderWarnings([...(resp.parse_warnings ?? []), ...(resp.load_warnings ?? [])]);
    document.getElementById("btn-to-questions").disabled = false;
    showToast("プロジェクトを復元しました。");
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

function renderFileInfo(resp) {
  const bar = document.getElementById("file-info-bar");
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <div class="info-item">
      <span class="info-label">ファイル:</span>
      <span class="info-value">${escHtml(resp.filename)}</span>
    </div>
    <div class="info-item">
      <span class="info-label">設問数:</span>
      <span class="info-value">${resp.row_count}</span>
    </div>
    ${resp.encoding_detected !== "Excel" ? `
    <div class="info-item">
      <span class="info-label">文字コード:</span>
      <span class="info-value">${escHtml(resp.encoding_detected)}</span>
    </div>` : ""}
    <div class="info-item">
      <span class="info-label">選択肢列:</span>
      <span class="info-value">${escHtml(CHOICE_MODE_LABEL[resp.choice_column_mode] ?? resp.choice_column_mode)}</span>
    </div>
    <div class="info-item">
      <span class="info-label">ファイルサイズ:</span>
      <span class="info-value">${(resp.file_size / 1024).toFixed(1)} KB</span>
    </div>
  `;
}

function renderWarnings(warnings) {
  const box = document.getElementById("parse-warnings-box");
  if (!warnings || warnings.length === 0) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="warning-title">⚠ パース警告 (${warnings.length} 件)</div>
    <ul>${warnings.map(w => `<li>${escHtml(w)}</li>`).join("")}</ul>
  `;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

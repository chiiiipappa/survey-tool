/**
 * アップロードパネルの制御。
 */
import { uploadFile, loadProject } from "./api.js";
import { setUploadResult, setLoadedProject } from "./state.js";
import { showToast, showError, showSpinner, hideSpinner, activatePanel } from "./app.js";

const CHOICE_MODE_LABEL = {
  multi_col:            "複数列（選択肢1, 選択肢2…）",
  single_col_delimited: "単一列（区切り文字）",
  none:                 "選択肢列なし",
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
    setUploadResult(resp);
    renderFileInfo(resp);
    renderWarnings(resp.parse_warnings ?? []);
    document.getElementById("btn-to-questions").disabled = false;
    showToast(`${resp.row_count} 設問を読み込みました。`);
    activatePanel("questions");
  } catch (err) {
    showError(err.message);
  } finally {
    hideSpinner();
  }
}

export function reloadLastCsvFile() {
  if (_lastFile) return handleCsvFile(_lastFile);
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

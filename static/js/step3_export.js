/**
 * STEP3 エクスポート機能。
 * PNG（クライアントサイド canvas.toDataURL）、
 * Excel / CSV（サーバーサイド API 経由）を提供する。
 */
import { AppState } from "./state.js";
import { exportCrosstabExcel, exportCrosstabCsv } from "./api.js";
import {
  sortedRows,
  getSettings,
  getColorsForGraph,
  getColorSeriesLabels,
  getLastCrosstabData,
  getCharts,
} from "./step3.js";

// ---------------------------------------------------------------------------
// ペイロード組み立て
// ---------------------------------------------------------------------------

/**
 * 現在のクロス集計データ・設定・色を Step3ExportRequest 形式に変換する。
 * @param {number|undefined} questionIdx 指定時は該当設問のみ。省略時は全設問。
 */
function _buildExportPayload(questionIdx) {
  const data = getLastCrosstabData();
  if (!data) return null;

  const { axis_question_code, axis_question_text, axis_categories, axis_totals, results } = data;

  const targets = questionIdx !== undefined
    ? (results[questionIdx] ? [results[questionIdx]] : [])
    : results.filter(r => {
        const s = getSettings(r.question_code, r.type_code);
        return !s.excluded;
      });

  const questions = targets.map(result => {
    const s = getSettings(result.question_code, result.type_code);
    const colorLabels = getColorSeriesLabels(result, s, axis_categories);
    const colors = getColorsForGraph(result.question_code, colorLabels);
    const sorted = sortedRows(result.rows, s.sortOrder);
    const filtered = sorted.filter(r => !(s.hiddenChoices ?? []).includes(r.label));

    return {
      question_code:   result.question_code,
      question_text:   result.question_text,
      type_code:       result.type_code,
      chart_type:      s.chartType,
      orientation:     s.orientation,
      show_pct_label:  s.showPctLabel,
      transpose:       s.transpose,
      graph_title:     s.graphTitle ?? "",
      resolved_colors: colors,
      rows:            filtered.map(r => ({
        label:    r.label,
        percents: r.percents,
        counts:   r.counts,
      })),
    };
  });

  return { axis_question_code, axis_question_text, axis_categories, axis_totals, questions };
}

// ---------------------------------------------------------------------------
// Excel エクスポート
// ---------------------------------------------------------------------------

export async function exportSingleExcel(idx) {
  const payload = _buildExportPayload(idx);
  if (!payload || !payload.questions.length) return;
  try {
    await exportCrosstabExcel(payload);
  } catch (e) {
    alert(`Excel エクスポートエラー: ${e.message}`);
  }
}

export async function exportAllExcel() {
  const payload = _buildExportPayload(undefined);
  if (!payload || !payload.questions.length) { alert("エクスポート対象の設問がありません。"); return; }
  try {
    await exportCrosstabExcel(payload);
  } catch (e) {
    alert(`Excel エクスポートエラー: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// CSV エクスポート
// ---------------------------------------------------------------------------

export async function exportSingleCsv(idx) {
  const data = getLastCrosstabData();
  if (!data) return;
  const result = data.results[idx];
  if (!result) return;
  const payload = _buildExportPayload(idx);
  if (!payload) return;
  try {
    await exportCrosstabCsv(payload, { single: true, questionCode: result.question_code });
  } catch (e) {
    alert(`CSV エクスポートエラー: ${e.message}`);
  }
}

export async function exportAllCsv() {
  const payload = _buildExportPayload(undefined);
  if (!payload || !payload.questions.length) { alert("エクスポート対象の設問がありません。"); return; }
  try {
    await exportCrosstabCsv(payload);
  } catch (e) {
    alert(`CSV エクスポートエラー: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// PNG エクスポート（クライアントサイドのみ）
// ---------------------------------------------------------------------------

function _downloadCanvas(canvas, filename) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

export function exportSinglePng(idx) {
  const data = getLastCrosstabData();
  const charts = getCharts();
  if (!data || !charts) return;

  const result = data.results[idx];
  if (!result) return;
  const qCode = result.question_code;

  const areaId  = `step3-chart-area-${idx}`;
  const chartVal = charts.get(areaId);
  if (!chartVal) {
    alert("このグラフはPNG出力できません（表のみ設定）。");
    return;
  }

  const allCharts = Array.isArray(chartVal) ? chartVal : [chartVal];
  if (allCharts.length === 1) {
    _downloadCanvas(allCharts[0].canvas, `${qCode}.png`);
  } else {
    allCharts.forEach((c, i) => _downloadCanvas(c.canvas, `${qCode}_${i + 1}.png`));
  }
}

export function exportAllPng() {
  const data = getLastCrosstabData();
  if (!data) return;
  data.results.forEach((_, i) => {
    const s = getSettings(data.results[i].question_code, data.results[i].type_code);
    if (!s.excluded) exportSinglePng(i);
  });
}

// ---------------------------------------------------------------------------
// 一括ボタンのイベント登録
// ---------------------------------------------------------------------------

export function initStep3ExportBulkButtons() {
  document.getElementById("step3-export-all-excel")
    ?.addEventListener("click", exportAllExcel);
  document.getElementById("step3-export-all-csv")
    ?.addEventListener("click", exportAllCsv);
  document.getElementById("step3-export-all-png")
    ?.addEventListener("click", exportAllPng);
}

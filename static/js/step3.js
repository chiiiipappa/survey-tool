/**
 * STEP3: クロス集計・グラフ作成パネル。
 *
 * 将来の2軸比較モードを想定し、選択軸は配列で管理する構造にしている（現在は1軸のみ）。
 */
import { AppState, setStep3ActiveAxis } from "./state.js";
import { generateCrosstab } from "./api.js";

// Chart.js インスタンスを管理（canvas再利用時に destroy が必要）
const _charts = new Map();

export function initStep3Panel() {
  document.addEventListener("survey:statechange", _onStateChange);

  document.getElementById("step3-run-btn")?.addEventListener("click", _runCrosstab);
}

// ---------------------------------------------------------------------------
// 状態変化ハンドラ
// ---------------------------------------------------------------------------

function _onStateChange() {
  if (AppState.activePanel !== "step3") return;
  _renderAxisCandidates();
  _renderAxisSelector();
  _updateRunButton();
}

// ---------------------------------------------------------------------------
// セクション1: 集計軸候補バッジ
// ---------------------------------------------------------------------------

function _renderAxisCandidates() {
  const el = document.getElementById("step3-axis-candidates");
  if (!el) return;

  const codes = AppState.step1AxisCodes;
  if (!codes.length) {
    el.innerHTML = '<span class="text-sm" style="color:var(--color-text-muted)">STEP1 で集計軸を選択してください。</span>';
    return;
  }

  el.innerHTML = codes
    .map(code => {
      const label = _getAxisLabel(code);
      return `<span class="badge">${_esc(label)}</span>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// セクション2: ラジオボタン軸セレクター
// ---------------------------------------------------------------------------

function _renderAxisSelector() {
  const el = document.getElementById("step3-axis-selector");
  if (!el) return;

  const candidates = _getAxisCandidates();

  if (!candidates.length) {
    const hasStep2 = Boolean(AppState.step2Filename);
    const msg = hasStep2
      ? "STEP1 で選択した集計軸がデータと一致しませんでした。"
      : "STEP2 で回答データをアップロードしてください。";
    el.innerHTML = `<span class="text-sm" style="color:var(--color-text-muted)">${_esc(msg)}</span>`;
    return;
  }

  // 現在の選択値が候補に含まれているか確認
  let currentCode = AppState.step3ActiveAxisCode;
  if (!candidates.includes(currentCode)) {
    currentCode = candidates[0];
    setStep3ActiveAxis(currentCode);
  }

  el.innerHTML = candidates
    .map(code => {
      const label = _getAxisLabel(code);
      const checked = code === currentCode ? "checked" : "";
      return `
        <label class="step3-axis-radio-label" style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:6px 12px; border-radius:6px; border:1px solid var(--color-border); background:${code === currentCode ? "var(--color-primary-light, #EFF6FF)" : "var(--color-surface-1, #fff)"}">
          <input type="radio" name="step3-axis" value="${_esc(code)}" ${checked} style="accent-color:var(--color-primary)">
          <span style="font-size:.9rem">${_esc(label)}</span>
        </label>`;
    })
    .join("");

  // ラジオボタン変更イベント
  el.querySelectorAll("input[name='step3-axis']").forEach(radio => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        setStep3ActiveAxis(radio.value);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 実行ボタン制御
// ---------------------------------------------------------------------------

function _updateRunButton() {
  const btn = document.getElementById("step3-run-btn");
  const note = document.getElementById("step3-run-note");
  if (!btn) return;

  const hasStep2 = Boolean(AppState.step2Filename);
  const hasAxis = Boolean(AppState.step3ActiveAxisCode) && _getAxisCandidates().length > 0;

  btn.disabled = !hasStep2 || !hasAxis;

  if (note) {
    if (!hasStep2) {
      note.textContent = "STEP2 で回答データをアップロードすると実行できます。";
    } else if (!hasAxis) {
      note.textContent = "STEP1 で集計軸を選択してください。";
    } else {
      note.textContent = "";
    }
  }
}

// ---------------------------------------------------------------------------
// クロス集計実行
// ---------------------------------------------------------------------------

async function _runCrosstab() {
  const axisCode = AppState.step3ActiveAxisCode;
  if (!axisCode || !AppState.sessionToken) return;

  const btn = document.getElementById("step3-run-btn");
  const resultsEl = document.getElementById("step3-results");
  if (!resultsEl) return;

  btn.disabled = true;
  btn.textContent = "⏳ 集計中…";
  resultsEl.style.display = "none";

  // 既存グラフを破棄
  _destroyAllCharts();

  try {
    const data = await generateCrosstab(AppState.sessionToken, axisCode);
    AppState.step3LastGeneratedAxisCode = axisCode;
    _renderResults(resultsEl, data);
    resultsEl.style.display = "";
  } catch (err) {
    resultsEl.style.display = "";
    resultsEl.innerHTML = `<div class="card"><div class="card-body" style="color:var(--color-danger,#e53e3e)">エラー: ${_esc(err.message)}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "📊 クロス集計を生成";
    _updateRunButton();
  }
}

// ---------------------------------------------------------------------------
// セクション3: 結果描画
// ---------------------------------------------------------------------------

function _renderResults(container, data) {
  const { axis_question_text, axis_categories, axis_totals, results, warnings } = data;

  // カラーパレット（軸カテゴリー数に対応）
  const COLORS = [
    "#4299E1", "#F6AD55", "#68D391", "#F687B3", "#9F7AEA",
    "#76E4F7", "#FC8181", "#B7EE8F", "#F6E05E", "#90CDF4",
  ];

  let html = "";

  // 軸サマリー
  html += `<div class="card" style="margin-bottom:12px">
    <div class="card-body" style="padding:12px 16px">
      <div style="font-weight:600; margin-bottom:8px">${_esc(axis_question_text)}（表側）</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px">`;
  axis_categories.forEach((cat, i) => {
    const color = COLORS[i % COLORS.length];
    html += `<span style="display:inline-flex; align-items:center; gap:4px; font-size:.85rem">
      <span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:${color}"></span>
      ${_esc(cat)} <span style="color:var(--color-text-muted)">n=${axis_totals[i] ?? 0}</span>
    </span>`;
  });
  html += `</div>`;
  if (warnings.length) {
    html += `<div style="margin-top:8px; color:var(--color-warning,#c05621); font-size:.8rem">${warnings.map(w => _esc(w)).join("<br>")}</div>`;
  }
  html += `</div></div>`;

  // 設問ごとのカード
  results.forEach((result, idx) => {
    const canvasId = `step3-chart-${idx}`;
    html += `
    <div class="card" style="margin-bottom:12px">
      <div class="card-header" style="padding:10px 16px">
        <span class="text-sm" style="color:var(--color-text-muted); margin-right:6px">${_esc(result.question_code)}</span>
        <span style="font-weight:600; font-size:.95rem">${_esc(result.question_text)}</span>
      </div>
      <div class="card-body" style="padding:16px">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start">
          <div style="position:relative; height:260px">
            <canvas id="${canvasId}"></canvas>
          </div>
          <div style="overflow-x:auto">
            ${_buildTable(result, axis_categories, axis_totals)}
          </div>
        </div>
      </div>
    </div>`;
  });

  if (!results.length) {
    html += `<div class="card"><div class="card-body" style="color:var(--color-text-muted); text-align:center; padding:32px">
      クロス集計できる設問がありませんでした。
    </div></div>`;
  }

  container.innerHTML = html;

  // Chart.js グラフを描画
  results.forEach((result, idx) => {
    const canvasId = `step3-chart-${idx}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const labels = result.rows.map(r => r.label);
    const datasets = axis_categories.map((cat, ci) => ({
      label: cat,
      data: result.rows.map(r => r.percents[ci] ?? 0),
      backgroundColor: COLORS[ci % COLORS.length],
    }));

    const chart = new Chart(canvas, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
            },
          },
        },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
          y: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: v => `${v}%` },
          },
        },
      },
    });
    _charts.set(canvasId, chart);
  });
}

function _buildTable(result, axisCategories, axisTotals) {
  const headerCols = axisCategories
    .map((cat, i) => `<th style="text-align:right; white-space:nowrap; padding:4px 8px; font-size:.8rem">${_esc(cat)}<br><span style="font-weight:400; color:var(--color-text-muted)">n=${axisTotals[i] ?? 0}</span></th>`)
    .join("");

  const rows = result.rows
    .map(row => {
      const cells = axisCategories
        .map((_, i) => `<td style="text-align:right; padding:3px 8px; font-size:.82rem; white-space:nowrap">${row.percents[i]?.toFixed(1) ?? "0.0"}%<br><span style="color:var(--color-text-muted); font-size:.75rem">(${row.counts[i] ?? 0})</span></td>`)
        .join("");
      return `<tr>
        <td style="padding:3px 8px; font-size:.82rem; white-space:nowrap; max-width:180px; overflow:hidden; text-overflow:ellipsis" title="${_esc(row.label)}">${_esc(row.label)}</td>
        ${cells}
      </tr>`;
    })
    .join("");

  return `<table style="border-collapse:collapse; width:100%; font-size:.82rem">
    <thead style="background:var(--color-surface-2,#F8F8F8)">
      <tr>
        <th style="text-align:left; padding:4px 8px; font-size:.8rem">選択肢</th>
        ${headerCols}
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** STEP1選択軸 ∩ STEP2で存在する軸 = STEP3で選択できる軸候補 */
function _getAxisCandidates() {
  const step1Codes = new Set(AppState.step1AxisCodes);
  if (!step1Codes.size) return [];

  // STEP2データがある場合は実際に存在する列との交差
  const step2Candidates = AppState.step2AxisCandidates;
  if (step2Candidates.length) {
    const step2Codes = new Set(step2Candidates.map(c => c.question_code));
    return [...step1Codes].filter(c => step2Codes.has(c));
  }

  // STEP2未アップロードの場合は候補なし（実行不可）
  return [];
}

function _getAxisLabel(code) {
  const q = AppState.questions.find(q => q.question_code === code);
  return q ? (q.stub || q.question_text || code) : code;
}

function _destroyAllCharts() {
  _charts.forEach(chart => chart.destroy());
  _charts.clear();
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

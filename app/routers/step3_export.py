"""
STEP3 エクスポートエンドポイント。
- POST /api/step3/export/excel  → .xlsx（1ファイル・複数シート）
- POST /api/step3/export/csv   → .zip（設問ごとの CSV を格納）
                                 ?single=true&question_code=XX の場合は単一 CSV
"""
import io
import zipfile
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.schemas import ExportQuestion, Step3ExportRequest
from app.step3_excel import build_excel_workbook

router = APIRouter()

_CHART_TYPE_LABELS = {
    "bar":        "棒グラフ",
    "grouped":    "grouped棒",
    "stacked100": "100%積み上げ",
    "pie":        "円グラフ",
    "avg_bar":    "平均棒",
    "table_only": "表のみ",
}
_ORIENT_LABELS = {"v": "（縦）", "h": "（横）"}


def _chart_type_label(q: ExportQuestion) -> str:
    base = _CHART_TYPE_LABELS.get(q.chart_type, q.chart_type)
    if q.chart_type in ("bar", "grouped", "stacked100"):
        base += _ORIENT_LABELS.get(q.orientation, "")
    return base


def _safe_filename(name: str) -> str:
    """RFC 5987 エンコード（日本語ファイル名対応）"""
    return f"UTF-8''{quote(name, safe='')}"


# ---------------------------------------------------------------------------
# Excel エクスポート
# ---------------------------------------------------------------------------

@router.post("/step3/export/excel")
async def export_excel(body: Step3ExportRequest):
    buf = build_excel_workbook(body)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"crosstab_{body.axis_question_code}_{ts}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{filename}\"; "
                f"filename*={_safe_filename(filename)}"
            )
        },
    )


# ---------------------------------------------------------------------------
# CSV エクスポート
# ---------------------------------------------------------------------------

def _build_csv_content(
    q: ExportQuestion,
    axis_categories: list[str],
    axis_totals: list[int],
    axis_question_text: str,
) -> str:
    lines: list[str] = []

    title = q.graph_title or q.question_text
    lines += [
        f"設問コード,{q.question_code}",
        f"質問文,{title}",
        f"集計軸,{axis_question_text}",
        f"グラフ種類,{_chart_type_label(q)}",
        "",
    ]

    # ヘッダー行（n数付き）
    header_cols = ["選択肢"] + [
        f"{cat}(n={tot})" for cat, tot in zip(axis_categories, axis_totals)
    ]

    # %表
    lines.append("【%表】")
    lines.append(",".join(header_cols))
    for row in q.rows:
        vals = [row.label] + [str(round(p, 1)) for p in row.percents]
        lines.append(",".join(vals))

    lines.append("")

    # N表
    lines.append("【N表】")
    lines.append(",".join(header_cols))
    for row in q.rows:
        vals = [row.label] + [str(c) for c in row.counts]
        lines.append(",".join(vals))

    return "\n".join(lines)


@router.post("/step3/export/csv")
async def export_csv(
    body: Step3ExportRequest,
    single: Optional[bool] = False,
    question_code: Optional[str] = None,
):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    # 単一CSVモード
    if single and question_code:
        target = next((q for q in body.questions if q.question_code == question_code), None)
        if target is None:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="question_code not found")
        content = _build_csv_content(
            target, body.axis_categories, body.axis_totals, body.axis_question_text
        )
        filename = f"{question_code}_{ts}.csv"
        return StreamingResponse(
            iter([content.encode("utf-8-sig")]),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": (
                    f"attachment; filename=\"{filename}\"; "
                    f"filename*={_safe_filename(filename)}"
                )
            },
        )

    # ZIP モード（全設問）
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for q in body.questions:
            content = _build_csv_content(
                q, body.axis_categories, body.axis_totals, body.axis_question_text
            )
            zf.writestr(f"{q.question_code}.csv", content.encode("utf-8-sig"))
    buf.seek(0)

    filename = f"crosstab_{body.axis_question_code}_{ts}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"{filename}\"; "
                f"filename*={_safe_filename(filename)}"
            )
        },
    )

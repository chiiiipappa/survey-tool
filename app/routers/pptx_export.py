"""STEP4 レポート → PowerPoint (.pptx) エクスポート API。"""

from __future__ import annotations

import io
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.pptx_builder import build_pptx, count_split_charts

router = APIRouter()


class PptxExportRequest(BaseModel):
    pages: list[dict[str, Any]]
    chart_results: list[dict[str, Any]]


@router.post("/report/export/pptx", summary="STEP4 レポートを PowerPoint に変換してダウンロード")
async def export_pptx(req: PptxExportRequest):
    expected, actual, data = build_pptx(req.pages, req.chart_results)
    headers = {
        "Content-Disposition": 'attachment; filename="report.pptx"',
        "X-Split-Charts-Expected": str(expected),
        "X-Split-Charts-Actual":   str(actual),
    }
    if expected > 0 and actual != expected:
        headers["X-Split-Charts-Warning"] = f"件数不一致: 期待={expected} 出力={actual}"
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers=headers,
    )

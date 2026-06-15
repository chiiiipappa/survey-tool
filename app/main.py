"""FastAPI アプリケーション本体。ルーター登録・静的ファイル配信。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from app.routers import questions, upload
from app.routers import step2 as step2_router
from app.routers import step3 as step3_router
from app.routers import step3_export as step3_export_router
from app.routers import report as report_router
from app.routers import pptx_export as pptx_export_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent.parent / "static"


class _NoCacheStaticFiles(StaticFiles):
    """開発用: JS ファイルをブラウザにキャッシュさせない。"""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if path.endswith(".js"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.parquet_cache import cleanup_old_sessions
    removed = cleanup_old_sessions(max_age_seconds=7200)
    logger.info("=== 調査票レイアウト確認ツール起動 === (古い Parquet %d 件削除)", removed)
    logger.info("=== http://localhost:8002 をブラウザで開いてください ===")
    yield
    logger.info("=== アプリケーション終了 ===")


app = FastAPI(
    title="調査票レイアウト確認ツール",
    description="レイアウト CSV を読み込み、設問構造の確認・回答データのラベル変換を行うツール。完全オフライン動作。",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.include_router(upload.router, prefix="/api", tags=["upload"])
app.include_router(questions.router, prefix="/api", tags=["questions"])
app.include_router(step2_router.router, prefix="/api", tags=["step2"])
app.include_router(step3_router.router, prefix="/api", tags=["step3"])
app.include_router(step3_export_router.router, prefix="/api", tags=["step3-export"])
app.include_router(report_router.router, prefix="/api", tags=["report"])
app.include_router(pptx_export_router.router, prefix="/api", tags=["pptx-export"])

app.mount("/static", _NoCacheStaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
async def root() -> FileResponse:
    return FileResponse(
        str(STATIC_DIR / "index.html"),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/health", summary="ヘルスチェック")
async def health() -> dict:
    return {"status": "healthy", "version": "1.0.0"}

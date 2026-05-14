"""FastAPI アプリケーション本体。ルーター登録・静的ファイル配信。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.routers import questions, upload
from app.routers import step2 as step2_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("=== 調査票レイアウト確認ツール起動 ===")
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

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
async def root() -> FileResponse:
    return FileResponse(
        str(STATIC_DIR / "index.html"),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/health", summary="ヘルスチェック")
async def health() -> dict:
    return {"status": "healthy", "version": "1.0.0"}

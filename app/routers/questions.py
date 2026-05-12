"""設問一覧ルーター: 検索・フィルタ・JSON 出力・プロジェクト保存・復元。"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from app.data_store import survey_cache
from app.schemas import (
    GraphConfig,
    LayoutFileInfo,
    ProjectData,
    ProjectLoadResponse,
    QuestionsJsonResponse,
    QuestionsResponse,
    QuestionItem,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _require_session(session_token: str) -> list[QuestionItem]:
    """セッションが存在すれば設問リストを返す。なければ 404 を上げる。"""
    questions = survey_cache.get_questions(session_token)
    if questions is None:
        raise HTTPException(
            status_code=404,
            detail="セッションが見つかりません。ファイルを再アップロードしてください。",
        )
    return questions


def _filter_questions(
    questions: list[QuestionItem],
    search: Optional[str],
    type_filter: Optional[str],
    include_children: bool,
) -> list[QuestionItem]:
    result = questions

    if not include_children:
        result = [q for q in result if not q.is_child]

    if type_filter:
        result = [q for q in result if q.type_code == type_filter]

    if search:
        lower = search.lower()
        result = [
            q for q in result
            if lower in q.question_code.lower() or lower in q.question_text.lower()
        ]

    return result


@router.get("/questions", response_model=QuestionsResponse, summary="設問一覧取得")
async def get_questions(
    session_token: str = Query(...),
    search: Optional[str] = Query(None),
    type_filter: Optional[str] = Query(None),
    include_children: bool = Query(True),
) -> QuestionsResponse:
    """設問リストを検索・フィルタして返す。"""
    questions = _require_session(session_token)
    meta = survey_cache.get_meta(session_token)

    filtered = _filter_questions(questions, search, type_filter, include_children)

    return QuestionsResponse(
        session_token=session_token,
        total_count=len(questions),
        filtered_count=len(filtered),
        questions=filtered,
        all_type_codes=meta.get("all_type_codes", []),
        parse_warnings=meta.get("parse_warnings", []),
    )


@router.get("/questions/json", response_model=QuestionsJsonResponse, summary="設問 JSON 取得（デバッグ用）")
async def get_questions_json(
    session_token: str = Query(...),
) -> QuestionsJsonResponse:
    """内部データ全量を JSON で返す（検索・フィルタなし）。"""
    questions = _require_session(session_token)
    return QuestionsJsonResponse(session_token=session_token, questions=questions)


@router.post("/project/save", summary="プロジェクトJSON ダウンロード")
async def save_project(session_token: str = Query(...)) -> StreamingResponse:
    """
    現在のセッション状態をプロジェクト JSON としてダウンロードする。
    STEP1 ではレイアウト情報と設問構造のみ保存する。
    """
    questions = _require_session(session_token)
    meta = survey_cache.get_meta(session_token)

    project = ProjectData(
        version="1.0",
        saved_at=datetime.now(timezone.utc).isoformat(),
        layout_file=LayoutFileInfo(
            name=meta.get("filename", ""),
            encoding=meta.get("encoding", ""),
            size=meta.get("file_size", 0),
        ),
        questions=questions,
        parse_warnings=meta.get("parse_warnings", []),
        selected_question_codes=[],
        graphs=[],
    )

    json_bytes = project.model_dump_json(indent=2).encode("utf-8")
    filename = f"survey_project_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

    return StreamingResponse(
        iter([json_bytes]),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/project/load", response_model=ProjectLoadResponse, summary="プロジェクトJSON 復元")
async def load_project(file: UploadFile = File(...)) -> ProjectLoadResponse:
    """
    保存済みプロジェクト JSON を読み込み、セッションに復元する。
    """
    raw = await file.read()
    load_warnings: list[str] = []

    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"JSON の読み込みに失敗しました: {e}")

    try:
        project = ProjectData.model_validate(data)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"プロジェクトデータの検証に失敗しました: {e}")

    # バージョンチェック
    if project.version != "1.0":
        load_warnings.append(f"バージョン {project.version} は現在のバージョン (1.0) と異なります。")

    token = str(uuid.uuid4())
    meta = {
        "filename": project.layout_file.name,
        "encoding": project.layout_file.encoding,
        "file_size": project.layout_file.size,
        "raw": b"",
        "column_names": [],
        "choice_column_mode": "none",
        "parse_warnings": project.parse_warnings,
        "unknown_types": [],
        "all_type_codes": sorted(set(q.type_code for q in project.questions if q.type_code)),
    }
    survey_cache.set(token, project.questions, meta)

    logger.info(f"プロジェクト復元完了: {project.layout_file.name} token={token[:8]}...")

    return ProjectLoadResponse(
        session_token=token,
        questions=project.questions,
        parse_warnings=project.parse_warnings,
        graphs=project.graphs,
        load_warnings=load_warnings,
    )

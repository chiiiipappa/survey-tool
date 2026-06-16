"""設問一覧ルーター: 検索・フィルタ・JSON 出力。"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.data_store import survey_cache
from app.schemas import (
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




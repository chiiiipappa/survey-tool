"""設問一覧ルーター: 検索・フィルタ・JSON 出力・プロジェクト保存・復元。"""

from __future__ import annotations

import io
import json
import logging
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from app.data_store import survey_cache
from app.schemas import (
    FullProjectLoadResponse,
    GraphConfig,
    LayoutFileInfo,
    LayoutSaveData,
    ProjectData,
    ProjectLoadResponse,
    QuestionsJsonResponse,
    QuestionsResponse,
    QuestionItem,
    Step1AxisSettingsRequest,
    Step2SaveData,
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


@router.post("/step1/axis/settings", summary="STEP1 集計軸設定を保存")
async def save_step1_axis_settings(body: Step1AxisSettingsRequest) -> dict:
    """選択中の集計軸コードとSTEP3の選択軸をセッションメタキャッシュに保存する。"""
    questions = _require_session(body.session_token)
    meta = survey_cache.get_meta(body.session_token)
    meta["step1_axis_codes"] = body.step1_axis_codes
    meta["step3_active_axis_code"] = body.step3_active_axis_code
    survey_cache.set(body.session_token, questions, meta)
    return {"status": "ok"}


@router.post("/project/save", summary="プロジェクト ZIP (.surv) ダウンロード")
async def save_project(
    session_token: str = Query(...),
    project_name: str = Query(""),
) -> StreamingResponse:
    """現在のセッション状態を .surv（ZIP）形式でダウンロードする。STEP1・STEP2 を含む。"""
    questions = _require_session(session_token)
    meta = survey_cache.get_meta(session_token)
    step2 = survey_cache.get_step2(session_token)

    manifest = {
        "version": "2.0",
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "project_name": project_name,
        "has_step2": bool(step2),
    }

    layout_data = LayoutSaveData(
        layout_file=LayoutFileInfo(
            name=meta.get("filename", ""),
            encoding=meta.get("encoding", ""),
            size=meta.get("file_size", 0),
        ),
        questions=questions,
        parse_warnings=meta.get("parse_warnings", []),
        step1_axis_codes=meta.get("step1_axis_codes", []),
        choice_column_mode=meta.get("choice_column_mode", "none"),
        all_type_codes=meta.get("all_type_codes", []),
        step3_active_axis_code=meta.get("step3_active_axis_code", ""),
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("layout.json", layout_data.model_dump_json(indent=2))
        if step2:
            step2_dict = {}
            for k in Step2SaveData.model_fields:
                val = step2.get(k)
                if val is None:
                    field_info = Step2SaveData.model_fields[k]
                    val = field_info.default if field_info.default is not None else (
                        [] if "List" in str(field_info.annotation) else
                        {} if "dict" in str(field_info.annotation) else
                        0 if field_info.annotation in (int,) else ""
                    )
                step2_dict[k] = val
            step2_data = Step2SaveData(**step2_dict)
            zf.writestr("step2.json", step2_data.model_dump_json(indent=2))
    buf.seek(0)

    safe_name = "".join(
        c if (c.isascii() and (c.isalnum() or c in "-_")) else "_"
        for c in (project_name or "project")
    ) or "project"
    filename = f"{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.surv"

    from urllib.parse import quote
    encoded_name = quote(
        f"{(project_name or 'project')}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.surv",
        safe=""
    )

    return StreamingResponse(
        iter([buf.read()]),
        media_type="application/zip",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{filename}"; '
                f"filename*=UTF-8''{encoded_name}"
            )
        },
    )


@router.post("/project/load", response_model=FullProjectLoadResponse, summary="プロジェクト (.surv / .json) 復元")
async def load_project(file: UploadFile = File(...)) -> FullProjectLoadResponse:
    """
    保存済みプロジェクトを読み込む。
    ZIP (.surv) と旧 JSON (.json) の両形式に対応する。
    """
    raw = await file.read()
    load_warnings: list[str] = []

    if raw[:2] == b"PK":
        return _load_surv(raw, load_warnings)
    else:
        return _load_legacy_json(raw, load_warnings)


def _load_surv(raw: bytes, load_warnings: list[str]) -> FullProjectLoadResponse:
    """ZIP (.surv) 形式のプロジェクトを復元する。"""
    try:
        buf = io.BytesIO(raw)
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            manifest = json.loads(zf.read("manifest.json"))
            layout_raw = json.loads(zf.read("layout.json"))
            step2_raw = json.loads(zf.read("step2.json")) if "step2.json" in names else None
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"プロジェクトファイルの読み込みに失敗しました: {e}")

    version = manifest.get("version", "")
    if version != "2.0":
        load_warnings.append(f"バージョン {version} は現在 (2.0) と異なります。")

    try:
        layout = LayoutSaveData.model_validate(layout_raw)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"レイアウトデータの検証に失敗しました: {e}")

    step2: Optional[Step2SaveData] = None
    if step2_raw:
        try:
            step2 = Step2SaveData.model_validate(step2_raw)
        except Exception as e:
            load_warnings.append(f"STEP2 データの復元に失敗しました（スキップ）: {e}")

    token = str(uuid.uuid4())
    meta = {
        "filename": layout.layout_file.name,
        "encoding": layout.layout_file.encoding,
        "file_size": layout.layout_file.size,
        "raw": b"",
        "column_names": [],
        "choice_column_mode": layout.choice_column_mode,
        "parse_warnings": layout.parse_warnings,
        "unknown_types": [],
        "all_type_codes": layout.all_type_codes,
        "step1_axis_codes": layout.step1_axis_codes,
    }
    survey_cache.set(token, layout.questions, meta)

    if step2:
        survey_cache.set_step2(token, step2.model_dump())

    logger.info(
        "プロジェクト復元完了 (.surv): %s token=%s...",
        layout.layout_file.name, token[:8],
    )

    return FullProjectLoadResponse(
        session_token=token,
        project_name=manifest.get("project_name", ""),
        saved_at=manifest.get("saved_at", ""),
        layout=layout,
        has_step2=step2 is not None,
        step2=step2,
        step3_active_axis_code=layout.step3_active_axis_code,
        load_warnings=load_warnings,
    )


def _load_legacy_json(raw: bytes, load_warnings: list[str]) -> FullProjectLoadResponse:
    """旧 JSON 形式（v1.0）のプロジェクトを STEP1 のみ復元する。"""
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"JSON の読み込みに失敗しました: {e}")

    try:
        project = ProjectData.model_validate(data)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"プロジェクトデータの検証に失敗しました: {e}")

    load_warnings.append("旧バージョン（JSON 形式）のプロジェクトです。STEP1 のみ復元されます。")

    if project.version != "1.0":
        load_warnings.append(f"バージョン {project.version} は未知です。")

    all_type_codes = sorted(set(q.type_code for q in project.questions if q.type_code))

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
        "all_type_codes": all_type_codes,
        "step1_axis_codes": [],
    }
    survey_cache.set(token, project.questions, meta)

    layout = LayoutSaveData(
        layout_file=project.layout_file,
        questions=project.questions,
        parse_warnings=project.parse_warnings,
        step1_axis_codes=[],
        choice_column_mode="none",
        all_type_codes=all_type_codes,
    )

    logger.info(
        "プロジェクト復元完了 (legacy JSON): %s token=%s...",
        project.layout_file.name, token[:8],
    )

    return FullProjectLoadResponse(
        session_token=token,
        project_name="",
        saved_at=project.saved_at,
        layout=layout,
        has_step2=False,
        load_warnings=load_warnings,
    )

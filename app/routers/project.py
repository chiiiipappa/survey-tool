"""プロジェクト保存・読込エンドポイント。"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.data_store import survey_cache
from app.parquet_cache import save_parquet
from app.schemas import QuestionItem

logger = logging.getLogger(__name__)
router = APIRouter()

_FORMAT_VERSION = "1"


class ProjectSaveRequest(BaseModel):
    session_token: str
    project_name: str = ""
    step3_question_settings: dict = Field(default_factory=dict)
    step1_axis_colors: dict = Field(default_factory=dict)
    user_palettes: dict = Field(default_factory=dict)
    step3_mode: str = "brand_comparison"
    step3_basic_axis_code: str = ""
    step3_comparison_axis_code: str = ""
    step3_deep_dive_target: str = ""
    step3_deep_dive_targets: list = Field(default_factory=list)
    step3_secondary_axis_code: str = ""
    step3_composite_display_mode: str = "split"
    step3_color_priority: str = "axis1"
    step3_min_sample_size: int = 0
    step3_target_filter_column: str = ""
    step3_target_filter_values: list = Field(default_factory=list)
    question_sets: list = Field(default_factory=list)
    step3_crosstab_cache: dict = Field(default_factory=dict)
    hidden_question_types: list = Field(default_factory=list)
    excluded_questions: list = Field(default_factory=list)
    step3_views: dict = Field(default_factory=dict)
    report_project: dict = Field(default_factory=dict)
    chart_results: list = Field(default_factory=list)
    layout_format: str = "auto"
    response_format: str = "auto"
    survey_format: str = "unknown"
    score_settings: dict = Field(default_factory=dict)  # 平均点分析: question_code -> ScaleSettings
    score_mapping: dict = Field(default_factory=dict)    # 平均点分析: question_code -> ScoreMappingEntry[]
    fan_degree_settings: dict = Field(default_factory=dict)  # ファン度分析: type/設問選択/判定マトリクス等
    attr_settings: dict = Field(default_factory=dict)        # 属性分析: 単純集計対象・クロスペア


@router.post("/project/save", summary="プロジェクトを .surveyproject に保存")
async def save_project(body: ProjectSaveRequest) -> StreamingResponse:
    token = body.session_token
    questions = survey_cache.get_questions(token)
    if questions is None:
        raise HTTPException(404, "セッションが見つかりません。STEP1 からやり直してください。")

    meta = survey_cache.get_meta(token)
    step2 = survey_cache.get_step2(token)
    saved_at = datetime.now(timezone.utc).isoformat()

    def _build_zip() -> bytes:
        # Parquet ファイルの存在を事前確認して has_step2 フラグを正確に設定する
        raw_path = step2.get("raw_parquet_path") if step2 else None
        labeled_path = step2.get("labeled_parquet_path") if step2 else None
        raw_exists = bool(raw_path and Path(raw_path).exists())
        labeled_exists = bool(labeled_path and Path(labeled_path).exists())
        # has_step2: 回答データ本体（Parquet）が ZIP に含まれる場合のみ True
        has_step2_data = bool(step2) and raw_exists and labeled_exists
        # has_step2_meta: step2.json（メタデータ）だけでも保存する場合は True
        has_step2_meta = bool(step2)

        project_data = {
            "version": _FORMAT_VERSION,
            "saved_at": saved_at,
            "project_name": body.project_name,
            "layout_format": body.layout_format,
            "response_format": body.response_format,
            "survey_format": meta.get("survey_format", body.survey_format),
            "layout": {
                "filename": meta.get("filename", ""),
                "encoding": meta.get("encoding", ""),
                "file_size": meta.get("file_size", 0),
                "choice_column_mode": meta.get("choice_column_mode", "none"),
                "parse_warnings": meta.get("parse_warnings", []),
                "all_type_codes": meta.get("all_type_codes", []),
                "questions": [q.model_dump() for q in questions],
            },
            "step3_question_settings": body.step3_question_settings,
            "step1_axis_colors": body.step1_axis_colors,
            "user_palettes": body.user_palettes,
            "step3_mode": body.step3_mode,
            "step3_basic_axis_code": body.step3_basic_axis_code,
            "step3_comparison_axis_code": body.step3_comparison_axis_code,
            "step3_deep_dive_target": body.step3_deep_dive_target,
            "step3_deep_dive_targets": body.step3_deep_dive_targets,
            "step3_secondary_axis_code": body.step3_secondary_axis_code,
            "step3_composite_display_mode": body.step3_composite_display_mode,
            "step3_color_priority": body.step3_color_priority,
            "step3_min_sample_size": body.step3_min_sample_size,
            "step3_target_filter_column": body.step3_target_filter_column,
            "step3_target_filter_values": body.step3_target_filter_values,
            "question_sets": body.question_sets,
            "step3_crosstab_cache": body.step3_crosstab_cache,
            "hidden_question_types": body.hidden_question_types,
            "excluded_questions": body.excluded_questions,
            "step3_views": body.step3_views,
            "chart_results": body.chart_results,
            "report_project": body.report_project,
            "score_settings": body.score_settings,
            "score_mapping": body.score_mapping,
            "fan_degree_settings": body.fan_degree_settings,
            "attr_settings": body.attr_settings,
            "has_step2": has_step2_data,
            "has_step2_meta": has_step2_meta,
        }

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("project.json", json.dumps(project_data, ensure_ascii=False, indent=2))

            layout_raw: bytes | None = meta.get("raw")
            if layout_raw:
                layout_filename = meta.get("filename", "layout.xlsx")
                zf.writestr(f"original_files/{layout_filename}", layout_raw)

            if step2:
                step2_json_data = {k: v for k, v in step2.items()
                                   if k not in ("raw_parquet_path", "labeled_parquet_path")}
                zf.writestr("step2.json", json.dumps(step2_json_data, ensure_ascii=False, indent=2))

                if raw_exists:
                    zf.write(raw_path, "raw_data.parquet")
                if labeled_exists:
                    zf.write(labeled_path, "labeled_data.parquet")

        return buf.getvalue()

    zip_bytes = await asyncio.to_thread(_build_zip)

    safe_name = (body.project_name or "project").replace("/", "_").replace("\\", "_").strip()
    filename = f"{safe_name}.surveyproject"

    logger.info("プロジェクト保存: %s (%d bytes)", filename, len(zip_bytes))

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/project/load", summary="プロジェクトファイルを読み込む")
async def load_project(file: UploadFile = File(...)) -> dict:
    raw_bytes = await file.read()
    load_warnings: list[str] = []

    def _extract() -> tuple[dict, dict | None, bytes | None, bytes | None, str]:
        # 旧 JSON 形式 (legacy .json)
        if raw_bytes[:2] != b"PK":
            try:
                data = json.loads(raw_bytes.decode("utf-8"))
            except Exception as e:
                raise ValueError(f"JSON の読み込みに失敗しました: {e}")
            questions_raw = data.get("questions", [])
            all_types = sorted(set(q.get("type_code", "") for q in questions_raw if q.get("type_code")))
            lf = data.get("layout_file", {})
            pd_ = {
                "version": data.get("version", "1.0"),
                "saved_at": data.get("saved_at", ""),
                "project_name": "",
                "layout_format": "auto",
                "response_format": "auto",
                "has_step2": False,
                "layout": {
                    "filename": lf.get("name", ""),
                    "encoding": lf.get("encoding", ""),
                    "file_size": lf.get("size", 0),
                    "choice_column_mode": "none",
                    "parse_warnings": data.get("parse_warnings", []),
                    "all_type_codes": all_types,
                    "questions": questions_raw,
                },
            }
            return pd_, None, None, None, "legacy_json"

        buf = io.BytesIO(raw_bytes)
        try:
            zf_obj = zipfile.ZipFile(buf, "r")
        except zipfile.BadZipFile:
            raise ValueError("ファイルが壊れているか、ZIP 形式ではありません。")

        with zf_obj as zf:
            names = zf.namelist()

            # 新形式: project.json
            if "project.json" in names:
                pd_ = json.loads(zf.read("project.json"))
                sd_ = json.loads(zf.read("step2.json")) if "step2.json" in names else None
                rp_ = zf.read("raw_data.parquet") if "raw_data.parquet" in names else None
                lp_ = zf.read("labeled_data.parquet") if "labeled_data.parquet" in names else None
                return pd_, sd_, rp_, lp_, "surveyproject"

            # 旧 .surv 形式: manifest.json + layout.json
            if "manifest.json" in names and "layout.json" in names:
                manifest = json.loads(zf.read("manifest.json"))
                layout = json.loads(zf.read("layout.json"))
                lf = layout.get("layout_file", {})
                pd_ = {
                    "version": manifest.get("version", "2.0"),
                    "saved_at": manifest.get("saved_at", ""),
                    "project_name": manifest.get("project_name", ""),
                    "layout_format": layout.get("layout_format", "auto"),
                    "response_format": layout.get("response_format", "auto"),
                    "has_step2": False,
                    "layout": {
                        "filename": lf.get("name", ""),
                        "encoding": lf.get("encoding", ""),
                        "file_size": lf.get("size", 0),
                        "choice_column_mode": layout.get("choice_column_mode", "none"),
                        "parse_warnings": layout.get("parse_warnings", []),
                        "all_type_codes": layout.get("all_type_codes", []),
                        "questions": layout.get("questions", []),
                    },
                    "step3_question_settings": layout.get("step3_question_settings", {}),
                    "step1_axis_colors": layout.get("step1_axis_colors", {}),
                    "user_palettes": layout.get("user_palettes", {}),
                    "step3_mode": layout.get("step3_mode", "brand_comparison"),
                    "step3_basic_axis_code": layout.get("step3_basic_axis_code", ""),
                    "step3_comparison_axis_code": layout.get("step3_comparison_axis_code", ""),
                    "step3_deep_dive_target": layout.get("step3_deep_dive_target", ""),
                    "step3_deep_dive_targets": layout.get("step3_deep_dive_targets", []),
                    "step3_secondary_axis_code": layout.get("step3_secondary_axis_code", ""),
                    "step3_composite_display_mode": layout.get("step3_composite_display_mode", "split"),
                    "step3_color_priority": layout.get("step3_color_priority", "axis1"),
                    "step3_min_sample_size": layout.get("step3_min_sample_size", 0),
                    "step3_target_filter_column": layout.get("step3_target_filter_column", ""),
                    "step3_target_filter_values": layout.get("step3_target_filter_values", []),
                    "question_sets": layout.get("question_sets", []),
                    "step3_crosstab_cache": layout.get("step3_crosstab_cache", {}),
                    "hidden_question_types": layout.get("hidden_question_types", []),
                    "excluded_questions": layout.get("excluded_questions", []),
                    "step3_views": layout.get("step3_views", {}),
                    "chart_results": layout.get("chart_results", []),
                    "report_project": layout.get("report_project", {}),
                }
                return pd_, None, None, None, "surv"

            raise ValueError("project.json も manifest.json も見つかりません。ファイルが破損しています。")

    try:
        project_data, step2_data, raw_parquet_bytes, labeled_parquet_bytes, file_format = (
            await asyncio.to_thread(_extract)
        )
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(422, f"プロジェクトファイルの読み込みに失敗しました: {e}")

    if "survey_format" not in project_data:
        # 旧フォーマット（survey_format 未保存）からの復元: layout_format から推定する。
        _lf = project_data.get("layout_format", "auto")
        project_data["survey_format"] = _lf if _lf in ("intage", "questant") else "unknown"

    if file_format in ("legacy_json", "surv"):
        load_warnings.append(
            "旧バージョンのプロジェクトファイルです。STEP1・グラフ設定は復元されましたが、"
            "回答データ（STEP2以降）は再アップロードが必要です。"
        )

    # 設問を復元
    questions_raw = project_data.get("layout", {}).get("questions", [])
    try:
        questions = [QuestionItem(**q) for q in questions_raw]
    except Exception as e:
        raise HTTPException(422, f"設問データの復元に失敗しました: {e}")

    new_token = str(uuid.uuid4())

    layout_meta_raw = project_data.get("layout", {})
    meta = {
        "filename": layout_meta_raw.get("filename", ""),
        "encoding": layout_meta_raw.get("encoding", ""),
        "file_size": layout_meta_raw.get("file_size", 0),
        "raw": None,
        "choice_column_mode": layout_meta_raw.get("choice_column_mode", "none"),
        "parse_warnings": layout_meta_raw.get("parse_warnings", []),
        "all_type_codes": layout_meta_raw.get("all_type_codes", []),
        "layout_format": project_data.get("layout_format", "auto"),
        "survey_format": project_data.get("survey_format", "unknown"),
    }
    survey_cache.set(new_token, questions, meta)

    # STEP2 復元
    # has_step2: 回答データ本体（Parquet）が ZIP に含まれていたか
    # step2_data: step2.json の内容（メタデータのみの場合も含む）
    has_step2 = project_data.get("has_step2", False) and step2_data is not None
    step2_resp: dict | None = None
    step2_needs_reupload: bool = False

    def _build_step2_resp(src: dict) -> dict:
        """step2.json の内容からフロントエンド向けレスポンスを組み立てる。"""
        return {
            "filename": src.get("filename", ""),
            "encoding": src.get("encoding", ""),
            "file_size": src.get("file_size", 0),
            "response_row_count": src.get("response_row_count", 0),
            "response_col_count": src.get("response_col_count", 0),
            "matched_columns": src.get("matched_columns", []),
            "missing_columns": src.get("missing_columns", []),
            "extra_columns": src.get("extra_columns", []),
            "codebook": src.get("codebook", {}),
            "axis_candidates": src.get("axis_candidates", []),
            "selected_axis_columns": src.get("selected_axis_columns", []),
            "unmatched_values": src.get("unmatched_values", []),
            "multi_select_columns": src.get("multi_select_columns", []),
            "selected_fa_codes": src.get("selected_fa_codes", []),
            "selected_attr_columns": src.get("selected_attr_columns", []),
            "bracket_columns": src.get("bracket_columns", []),
        }

    if has_step2:
        if raw_parquet_bytes and labeled_parquet_bytes:
            def _restore_parquet() -> tuple:
                raw_df = pd.read_parquet(io.BytesIO(raw_parquet_bytes))
                labeled_df = pd.read_parquet(io.BytesIO(labeled_parquet_bytes))
                rp = save_parquet(new_token, raw_df, "raw_data")
                lp = save_parquet(new_token, labeled_df, "labeled_data")
                return str(rp), str(lp)

            try:
                raw_path, labeled_path = await asyncio.to_thread(_restore_parquet)
                restored_step2 = dict(step2_data)
                restored_step2["raw_parquet_path"] = raw_path
                restored_step2["labeled_parquet_path"] = labeled_path
                survey_cache.set_step2(new_token, restored_step2)
                step2_resp = _build_step2_resp(step2_data)
            except Exception as e:
                logger.warning("STEP2 Parquet 復元エラー: %s", e)
                has_step2 = False
                step2_needs_reupload = True
                step2_resp = _build_step2_resp(step2_data)
                load_warnings.append(
                    "回答データの復元に失敗しました。回答データを再アップロードしてください。"
                )
        else:
            has_step2 = False
            step2_needs_reupload = True
            step2_resp = _build_step2_resp(step2_data)
            load_warnings.append(
                "このプロジェクトには回答データ本体が保存されていないため、"
                "再分析には回答データの再アップロードが必要です。"
            )
    elif step2_data is not None:
        # has_step2=False だが step2.json は存在する場合（旧形式 or has_step2_meta=True）
        has_step2 = False
        step2_needs_reupload = True
        step2_resp = _build_step2_resp(step2_data)
        load_warnings.append(
            "このプロジェクトには回答データ本体が保存されていないため、"
            "再分析には回答データの再アップロードが必要です。"
        )

    layout_section = {
        **layout_meta_raw,
        "step3_secondary_axis_code": project_data.get("step3_secondary_axis_code", ""),
        "step3_mode": project_data.get("step3_mode", "brand_comparison"),
        "step3_basic_axis_code": project_data.get("step3_basic_axis_code", ""),
        "step3_comparison_axis_code": project_data.get("step3_comparison_axis_code", ""),
        "step3_deep_dive_target": project_data.get("step3_deep_dive_target", ""),
        "step3_deep_dive_targets": project_data.get("step3_deep_dive_targets", []),
        "step3_composite_display_mode": project_data.get("step3_composite_display_mode", "split"),
        "step3_color_priority": project_data.get("step3_color_priority", "axis1"),
        "step3_min_sample_size": project_data.get("step3_min_sample_size", 0),
        "step3_target_filter_column": project_data.get("step3_target_filter_column", ""),
        "step3_target_filter_values": project_data.get("step3_target_filter_values", []),
        "question_sets": project_data.get("question_sets", []),
        "step3_question_settings": project_data.get("step3_question_settings", {}),
        "step1_axis_colors": project_data.get("step1_axis_colors", {}),
        "user_palettes": project_data.get("user_palettes", {}),
        "hidden_question_types": project_data.get("hidden_question_types", []),
        "excluded_questions": project_data.get("excluded_questions", []),
        "step3_views": project_data.get("step3_views", {}),
        "chart_results": project_data.get("chart_results", []),
        "step3_crosstab_cache": project_data.get("step3_crosstab_cache", {}),
        "score_settings": project_data.get("score_settings", {}),
        "score_mapping": project_data.get("score_mapping", {}),
        "fan_degree_settings": project_data.get("fan_degree_settings", {}),
        "attr_settings": project_data.get("attr_settings", {}),
    }

    logger.info(
        "プロジェクト読込: name=%s, questions=%d, has_step2=%s, token=%s...",
        project_data.get("project_name", ""), len(questions), has_step2, new_token[:8],
    )

    return {
        "session_token": new_token,
        "project_name": project_data.get("project_name", ""),
        "saved_at": project_data.get("saved_at"),
        "layout_format": project_data.get("layout_format", "auto"),
        "response_format": project_data.get("response_format", "auto"),
        "survey_format": project_data.get("survey_format", "unknown"),
        "layout": layout_section,
        "has_step2": has_step2,
        "step2_needs_reupload": step2_needs_reupload,
        "step2": step2_resp,
        "step3_crosstab_configs": [],
        "step3_active_axis_code": project_data.get("step3_basic_axis_code", ""),
        "load_warnings": load_warnings,
        "report_project": project_data.get("report_project", {}),
    }

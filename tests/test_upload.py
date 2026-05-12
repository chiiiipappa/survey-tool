"""アップロードエンドポイントのテスト。"""

from __future__ import annotations

import pytest


def test_upload_csv_success(client, sample_csv_bytes):
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", sample_csv_bytes, "text/csv")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["session_token"]
    assert data["row_count"] == 6
    assert data["filename"] == "layout.csv"
    assert data["choice_column_mode"] == "multi_col"


def test_upload_non_csv_rejected(client):
    resp = client.post(
        "/api/upload",
        files={"file": ("data.xlsx", b"dummy", "application/octet-stream")},
    )
    assert resp.status_code == 422


def test_upload_returns_questions(client, sample_csv_bytes):
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", sample_csv_bytes, "text/csv")},
    )
    questions = resp.json()["questions"]
    codes = [q["question_code"] for q in questions]
    assert "F1" in codes
    assert "Q1" in codes
    assert "Q2_1" in codes


def test_upload_detects_child_questions(client, sample_csv_bytes):
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", sample_csv_bytes, "text/csv")},
    )
    questions = resp.json()["questions"]
    q2_1 = next(q for q in questions if q["question_code"] == "Q2_1")
    assert q2_1["is_child"] is True
    assert q2_1["parent_code"] == "Q2"


def test_upload_type_labels(client, sample_csv_bytes):
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", sample_csv_bytes, "text/csv")},
    )
    questions = resp.json()["questions"]
    f1 = next(q for q in questions if q["question_code"] == "F1")
    assert f1["type_label"] == "単一回答"
    q1 = next(q for q in questions if q["question_code"] == "Q1")
    assert q1["type_label"] == "複数回答"
    q3 = next(q for q in questions if q["question_code"] == "Q3")
    assert q3["type_label"] == "自由回答"
    q4 = next(q for q in questions if q["question_code"] == "Q4")
    assert q4["type_label"] == "数値"


def test_upload_choices(client, sample_csv_bytes):
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", sample_csv_bytes, "text/csv")},
    )
    questions = resp.json()["questions"]
    f1 = next(q for q in questions if q["question_code"] == "F1")
    assert f1["choice_count"] == 2
    assert f1["choices"][0]["choice_text"] == "男性"
    assert f1["choices"][1]["choice_text"] == "女性"


def test_upload_unknown_type_warning(client):
    csv_text = "コード,種別,質問文,表側\nQ1,XX,テスト設問,\n"
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "XX" in data["unknown_types"]
    assert any("XX" in w for w in data["parse_warnings"])


def test_upload_missing_required_column(client):
    csv_text = "コード,質問文\nQ1,テスト\n"
    resp = client.post(
        "/api/upload",
        files={"file": ("layout.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert resp.status_code == 422

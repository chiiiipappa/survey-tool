"""設問一覧エンドポイントのテスト。"""

from __future__ import annotations


def test_get_questions_all(client, uploaded_token):
    resp = client.get(f"/api/questions?session_token={uploaded_token}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_count"] == 6
    assert data["filtered_count"] == 6
    assert len(data["questions"]) == 6


def test_get_questions_search(client, uploaded_token):
    resp = client.get(f"/api/questions?session_token={uploaded_token}&search=Q2")
    assert resp.status_code == 200
    data = resp.json()
    codes = [q["question_code"] for q in data["questions"]]
    assert "Q2_1" in codes
    assert "Q2_2" in codes
    assert "F1" not in codes


def test_get_questions_type_filter(client, uploaded_token):
    resp = client.get(f"/api/questions?session_token={uploaded_token}&type_filter=SA")
    assert resp.status_code == 200
    data = resp.json()
    assert all(q["type_code"] == "SA" for q in data["questions"])
    assert data["filtered_count"] == 1


def test_get_questions_exclude_children(client, uploaded_token):
    resp = client.get(f"/api/questions?session_token={uploaded_token}&include_children=false")
    assert resp.status_code == 200
    data = resp.json()
    assert all(not q["is_child"] for q in data["questions"])


def test_get_questions_json(client, uploaded_token):
    resp = client.get(f"/api/questions/json?session_token={uploaded_token}")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["questions"]) == 6


def test_session_not_found(client):
    resp = client.get("/api/questions?session_token=nonexistent-token")
    assert resp.status_code == 404


def test_all_type_codes_returned(client, uploaded_token):
    resp = client.get(f"/api/questions?session_token={uploaded_token}")
    assert resp.status_code == 200
    codes = resp.json()["all_type_codes"]
    assert "SA" in codes
    assert "MA" in codes
    assert "ML" in codes
    assert "FA" in codes
    assert "NU" in codes


def test_project_save_returns_zip(client, uploaded_token):
    resp = client.post("/api/project/save", json={"session_token": uploaded_token, "project_name": "test"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/zip")
    # ZIP ファイルとして読める
    import io, zipfile
    with zipfile.ZipFile(io.BytesIO(resp.content), "r") as zf:
        names = zf.namelist()
        assert "manifest.json" in names
        assert "layout.json" in names
        import json
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["version"] == "2.0"
        layout = json.loads(zf.read("layout.json"))
        assert len(layout["questions"]) == 6


def test_project_load_surv(client, uploaded_token):
    # .surv で保存
    save_resp = client.post(
        "/api/project/save", json={"session_token": uploaded_token, "project_name": "test"}
    )
    surv_bytes = save_resp.content

    # .surv で復元
    load_resp = client.post(
        "/api/project/load",
        files={"file": ("project.surv", surv_bytes, "application/zip")},
    )
    assert load_resp.status_code == 200
    data = load_resp.json()
    assert data["session_token"]
    assert len(data["layout"]["questions"]) == 6
    assert data["has_step2"] is False


def test_project_load_legacy_json(client, uploaded_token):
    """旧 JSON 形式でも読み込めることを確認する（後方互換）。"""
    import json
    from app.schemas import ProjectData, LayoutFileInfo
    legacy = ProjectData(
        version="1.0",
        saved_at="2026-01-01T00:00:00",
        layout_file=LayoutFileInfo(name="old.csv", encoding="utf-8", size=0),
        questions=[],
        parse_warnings=[],
    )
    json_bytes = legacy.model_dump_json(indent=2).encode("utf-8")

    load_resp = client.post(
        "/api/project/load",
        files={"file": ("project.json", json_bytes, "application/json")},
    )
    assert load_resp.status_code == 200
    data = load_resp.json()
    assert data["session_token"]
    assert data["has_step2"] is False
    assert any("旧バージョン" in w for w in data["load_warnings"])


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"

"""pytest 共通フィクスチャ。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def sample_csv_bytes():
    """テスト用サンプル CSV (UTF-8)。"""
    csv_text = (
        "コード,種別,質問文,表側,選択肢1,選択肢2,選択肢3\n"
        "F1,SA,性別,,男性,女性,\n"
        "Q1,MA,趣味（複数回答可）,,読書,スポーツ,旅行\n"
        "Q2_1,ML,Q2 評価（デザイン）(MA),デザイン,非常に満足,やや満足,不満\n"
        "Q2_2,ML,Q2 評価（機能）(MA),機能,非常に満足,やや満足,不満\n"
        "Q3,FA,ご意見をご自由にお書きください,,,\n"
        "Q4,NU,年齢（歳）,,,\n"
    )
    return csv_text.encode("utf-8")


@pytest.fixture
def uploaded_token(client, sample_csv_bytes):
    """CSV をアップロードしてセッショントークンを返す。"""
    resp = client.post(
        "/api/upload",
        files={"file": ("test_layout.csv", sample_csv_bytes, "text/csv")},
    )
    assert resp.status_code == 200
    return resp.json()["session_token"]

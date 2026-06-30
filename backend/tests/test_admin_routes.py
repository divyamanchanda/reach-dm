"""
Tests for admin routes.

Requires the seeded database to be running:
  docker compose up -d
  PYTHONPATH=. python -m scripts.seed
"""

from fastapi.testclient import TestClient
from app.main import fastapi_app

client = TestClient(fastapi_app)


def login():
    r = client.post(
        "/api/auth/login",
        json={"phone": "+919876543210", "password": "reach2026"},
    )
    return r.json()["access_token"]


def test_csv_export_is_reachable():
    tok = login()
    r = client.get(
        "/api/admin/incidents/export?limit=100",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert r.status_code == 200  # would be 422 if A1 regressed
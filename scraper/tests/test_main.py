"""
Tests for the service's HTTP layer: health reporting and the shared-secret
auth guard (`_authorise`) that is this service's documented second security
layer behind internal-only network ingress -- see infra/scripts/
provision-guidance-scraper.sh and CLAUDE.md's Guidance Sources section.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

import main
import workers
from workers.base import ScrapedDocument


def _client() -> TestClient:
    return TestClient(main.app)


def test_health_reports_auth_not_required_when_no_secret_configured(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "")

    response = _client().get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["auth_required"] is False
    assert set(body["workers"]) == set(workers.registered_keys())


def test_health_reports_auth_required_when_secret_configured(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "some-secret")

    response = _client().get("/health")

    assert response.json()["auth_required"] is True


def test_scrape_succeeds_without_a_header_when_no_secret_is_configured(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "")
    sentinel = ScrapedDocument(
        source_key="gphc_standards", url="https://example.invalid", status="Succeeded"
    )
    monkeypatch.setattr(workers, "scrape", lambda source_key, url: sentinel)

    response = _client().post(
        "/scrape", json={"source_key": "gphc_standards", "url": "https://example.invalid"}
    )

    assert response.status_code == 200
    assert response.json()["status"] == "Succeeded"


def test_scrape_rejects_missing_secret_header_when_a_secret_is_configured(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "correct-secret")

    response = _client().post(
        "/scrape", json={"source_key": "gphc_standards", "url": "https://example.invalid"}
    )

    assert response.status_code == 401


def test_scrape_rejects_wrong_secret_header_when_a_secret_is_configured(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "correct-secret")

    response = _client().post(
        "/scrape",
        json={"source_key": "gphc_standards", "url": "https://example.invalid"},
        headers={"X-Scraper-Secret": "wrong-secret"},
    )

    assert response.status_code == 401


def test_scrape_accepts_correct_secret_header_when_a_secret_is_configured(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "correct-secret")
    sentinel = ScrapedDocument(
        source_key="gphc_standards", url="https://example.invalid", status="Succeeded"
    )
    monkeypatch.setattr(workers, "scrape", lambda source_key, url: sentinel)

    response = _client().post(
        "/scrape",
        json={"source_key": "gphc_standards", "url": "https://example.invalid"},
        headers={"X-Scraper-Secret": "correct-secret"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "Succeeded"


def test_scrape_reports_worker_exceptions_as_a_failed_document_not_a_500(monkeypatch):
    monkeypatch.setattr(main, "SHARED_SECRET", "")

    def raising_scrape(source_key, url):
        raise ValueError("simulated worker failure")

    monkeypatch.setattr(workers, "scrape", raising_scrape)

    response = _client().post(
        "/scrape", json={"source_key": "gphc_standards", "url": "https://example.invalid"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "Failed"
    assert "simulated worker failure" in body["error"]

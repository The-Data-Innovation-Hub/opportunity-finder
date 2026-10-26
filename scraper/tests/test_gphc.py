from __future__ import annotations

from tests.conftest import FakeResponse
from workers import gphc


def test_gphc_scrape_extracts_document_on_success(monkeypatch):
    html = """
    <html><body><article>
      <h1>Standards for pharmacy professionals</h1>
      <meta property="article:modified_time" content="2026-03-01T00:00:00Z">
      <p>Standards body text.</p>
    </article></body></html>
    """
    monkeypatch.setattr(gphc, "fetch", lambda url: FakeResponse(html))

    doc = gphc.scrape("https://example.invalid/standards")

    assert doc.status == "Succeeded"
    assert doc.source_key == "gphc_standards"
    assert doc.title == "Standards for pharmacy professionals"
    assert doc.last_updated_at == "2026-03-01T00:00:00Z"
    assert doc.content is not None and "Standards body text." in doc.content


def test_gphc_scrape_falls_back_to_time_element_for_last_updated(monkeypatch):
    html = """
    <html><body><article>
      <h1>Standards</h1>
      <time datetime="2026-03-02T00:00:00Z">2 Mar 2026</time>
      <p>Body.</p>
    </article></body></html>
    """
    monkeypatch.setattr(gphc, "fetch", lambda url: FakeResponse(html))

    doc = gphc.scrape("https://example.invalid/standards")

    assert doc.last_updated_at == "2026-03-02T00:00:00Z"


def test_gphc_scrape_reports_failure_on_non_200(monkeypatch):
    monkeypatch.setattr(gphc, "fetch", lambda url: FakeResponse("", status=500))

    doc = gphc.scrape("https://example.invalid/standards")

    assert doc.status == "Failed"
    assert doc.error == "HTTP 500"
    assert doc.source_key == "gphc_standards"

from __future__ import annotations

from tests.conftest import FakeResponse
from workers import generic


def test_generic_scrape_extracts_document_on_success(monkeypatch):
    html = """
    <html><body><article>
      <h1>Some Notice</h1>
      <meta property="article:published_time" content="2026-02-01T00:00:00Z">
      <meta property="article:modified_time" content="2026-02-03T00:00:00Z">
      <p>Body text.</p>
    </article></body></html>
    """
    monkeypatch.setattr(generic, "fetch", lambda url: FakeResponse(html))

    doc = generic.scrape("https://example.invalid/notice")

    assert doc.status == "Succeeded"
    assert doc.source_key == "generic"
    assert doc.title == "Some Notice"
    assert doc.published_at == "2026-02-01T00:00:00Z"
    assert doc.last_updated_at == "2026-02-03T00:00:00Z"
    assert doc.content is not None and "Body text." in doc.content


def test_generic_scrape_falls_back_to_time_element_for_published_at(monkeypatch):
    html = """
    <html><body><article>
      <h1>Some Notice</h1>
      <time datetime="2026-02-01T00:00:00Z">1 Feb 2026</time>
      <p>Body text.</p>
    </article></body></html>
    """
    monkeypatch.setattr(generic, "fetch", lambda url: FakeResponse(html))

    doc = generic.scrape("https://example.invalid/notice")

    assert doc.published_at == "2026-02-01T00:00:00Z"


def test_generic_scrape_reports_failure_on_non_200(monkeypatch):
    monkeypatch.setattr(generic, "fetch", lambda url: FakeResponse("", status=404))

    doc = generic.scrape("https://example.invalid/missing", source_key="some_source")

    assert doc.status == "Failed"
    assert doc.error == "HTTP 404"
    assert doc.source_key == "some_source"
    assert doc.content is None

from __future__ import annotations

from tests.conftest import FakeResponse
from workers import smc


def test_smc_scrape_extracts_document_on_success(monkeypatch):
    html = """
    <html><body><article>
      <h1>Medicines information library</h1>
      <meta property="article:modified_time" content="2026-04-05T00:00:00Z">
      <p>Advice link hub text.</p>
    </article></body></html>
    """
    monkeypatch.setattr(smc, "fetch", lambda url: FakeResponse(html))

    doc = smc.scrape("https://example.invalid/smc")

    assert doc.status == "Succeeded"
    assert doc.source_key == "smc_advice"
    assert doc.last_updated_at == "2026-04-05T00:00:00Z"
    assert doc.content is not None and "Advice link hub text." in doc.content


def test_smc_scrape_reports_failure_on_non_200(monkeypatch):
    monkeypatch.setattr(smc, "fetch", lambda url: FakeResponse("", status=503))

    doc = smc.scrape("https://example.invalid/smc")

    assert doc.status == "Failed"
    assert doc.error == "HTTP 503"
    assert doc.source_key == "smc_advice"

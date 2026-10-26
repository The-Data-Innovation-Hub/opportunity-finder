from __future__ import annotations

from tests.conftest import FakeResponse
from workers import sps


def test_sps_scrape_reads_published_and_last_updated_when_both_present(monkeypatch):
    html = """
    <html><body><article>
      <h1>Medication Safety Update</h1>
      <time datetime="2026-05-01T00:00:00Z">1 May 2026</time>
      <time datetime="2026-05-15T00:00:00Z">15 May 2026</time>
      <p>Monthly update body.</p>
    </article></body></html>
    """
    monkeypatch.setattr(sps, "fetch", lambda url: FakeResponse(html))

    doc = sps.scrape("https://example.invalid/sps")

    assert doc.status == "Succeeded"
    assert doc.source_key == "sps_medication_safety_update"
    assert doc.published_at == "2026-05-01T00:00:00Z"
    assert doc.last_updated_at == "2026-05-15T00:00:00Z"


def test_sps_scrape_does_not_report_a_bogus_update_when_never_revised(monkeypatch):
    # Only one <time> present -- must not treat it as also being the update.
    html = """
    <html><body><article>
      <h1>Medication Safety Update</h1>
      <time datetime="2026-05-01T00:00:00Z">1 May 2026</time>
      <p>First edition body.</p>
    </article></body></html>
    """
    monkeypatch.setattr(sps, "fetch", lambda url: FakeResponse(html))

    doc = sps.scrape("https://example.invalid/sps")

    assert doc.published_at == "2026-05-01T00:00:00Z"
    assert doc.last_updated_at is None


def test_sps_scrape_handles_no_time_elements_at_all(monkeypatch):
    html = "<html><body><article><h1>Update</h1><p>Body.</p></article></body></html>"
    monkeypatch.setattr(sps, "fetch", lambda url: FakeResponse(html))

    doc = sps.scrape("https://example.invalid/sps")

    assert doc.published_at is None
    assert doc.last_updated_at is None


def test_sps_scrape_reports_failure_on_non_200(monkeypatch):
    monkeypatch.setattr(sps, "fetch", lambda url: FakeResponse("", status=404))

    doc = sps.scrape("https://example.invalid/sps")

    assert doc.status == "Failed"
    assert doc.error == "HTTP 404"
    assert doc.source_key == "sps_medication_safety_update"

from __future__ import annotations

import workers
from workers.base import ScrapedDocument


def test_registered_keys_matches_the_registry_and_is_sorted():
    assert workers.registered_keys() == sorted(workers.REGISTRY.keys())
    assert set(workers.registered_keys()) == {
        "etenders_ie_latest",
        "find_a_grant",
        "funder_page",
        "ifs_competitions",
        "sps_medication_safety_update",
        "gphc_standards",
        "smc_advice",
        "rightbreathe_inhalers",
    }


def test_scrape_dispatches_to_the_worker_registered_for_the_key(monkeypatch):
    sentinel = ScrapedDocument(source_key="gphc_standards", url="u", status="Succeeded")
    called_with = {}

    def fake_gphc_scrape(url):
        called_with["url"] = url
        return sentinel

    monkeypatch.setitem(workers.REGISTRY, "gphc_standards", fake_gphc_scrape)

    result = workers.scrape("gphc_standards", "https://example.invalid/x")

    assert result is sentinel
    assert called_with["url"] == "https://example.invalid/x"


def test_scrape_falls_back_to_generic_worker_for_an_unregistered_key(monkeypatch):
    sentinel = ScrapedDocument(source_key="generic", url="u", status="Succeeded")
    called_with = {}

    def fake_generic_scrape(url, source_key="generic"):
        called_with["url"] = url
        called_with["source_key"] = source_key
        return sentinel

    monkeypatch.setattr(workers.generic, "scrape", fake_generic_scrape)

    result = workers.scrape("some_never_registered_key", "https://example.invalid/y")

    assert result is sentinel
    assert called_with["url"] == "https://example.invalid/y"

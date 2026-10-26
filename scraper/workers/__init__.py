"""
Per-source guidance workers.

Each worker owns one source's quirks (where its dates live, what its main
content container is). Workers are registered by source_key; the Node backend
sends that key, so adding a source is a matter of adding a worker here and a
guidance_source row with ingestion_method='scrapling'.

Unregistered keys fall back to the generic worker rather than failing, so a
newly-added source degrades to "document extracted, dates possibly missing"
instead of "not ingested at all".
"""

from .base import ScrapedDocument, build_document, fetch
from . import etenders_ie, find_a_grant, funder_page, generic, ifs_competitions, gphc, rightbreathe, smc, sps

REGISTRY = {
    "sps_medication_safety_update": sps.scrape,
    "gphc_standards": gphc.scrape,
    "smc_advice": smc.scrape,
    "rightbreathe_inhalers": rightbreathe.scrape,
    # Opportunity Finder listing workers
    "etenders_ie_latest": etenders_ie.scrape,
    "find_a_grant": find_a_grant.scrape,
    "funder_page": funder_page.scrape,
    "ifs_competitions": ifs_competitions.scrape,
}

LISTING_WORKERS = {"etenders_ie_latest", "find_a_grant", "ifs_competitions"}


def scrape(source_key: str, url: str, since: str | None = None) -> ScrapedDocument:
    worker = REGISTRY.get(source_key, generic.scrape)
    if source_key == "etenders_ie_latest":
        return worker(url, since=since)
    return worker(url)


def registered_keys() -> list[str]:
    return sorted(REGISTRY)

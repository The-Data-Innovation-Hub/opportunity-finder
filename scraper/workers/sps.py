"""
NHS Specialist Pharmacy Service -- Medication Safety Update.

This source is a single evergreen page that SPS revises monthly rather than a
feed of separate articles, so the signal that matters is its "Last updated"
date plus a stable content hash: a change to either is what tells us a new
monthly update has landed. Its <article> carries both dates as <time datetime>
elements, published first, last-updated second.
"""

from __future__ import annotations

from .base import ScrapedDocument, build_document, fetch

SOURCE_KEY = "sps_medication_safety_update"


def scrape(url: str) -> ScrapedDocument:
    page = fetch(url)
    if page.status != 200:
        return ScrapedDocument(
            source_key=SOURCE_KEY, url=url, status="Failed", error=f"HTTP {page.status}"
        )

    times = [t.attrib.get("datetime") for t in page.css("article time") if t.attrib.get("datetime")]
    published_at = times[0] if times else None
    # SPS renders "Published <date> · Last updated <date>"; when it has never
    # been revised only one <time> is present, so don't report a bogus update.
    last_updated_at = times[1] if len(times) > 1 else None

    return build_document(
        SOURCE_KEY,
        url,
        page,
        published_at=published_at,
        last_updated_at=last_updated_at,
    )

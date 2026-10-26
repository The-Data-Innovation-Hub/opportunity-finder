"""
General Pharmaceutical Council -- standards and guidance.

GPhC publishes standards as static documents revised ad hoc, with no feed and
no reliable per-page publication date, so change detection here rests on the
content hash rather than a date. The landing page carries <article> blocks for
current items; we capture the page as one document rather than inventing a
per-standard article list the markup does not actually support.
"""

from __future__ import annotations

from .base import ScrapedDocument, build_document, fetch, first_attr

SOURCE_KEY = "gphc_standards"


def scrape(url: str) -> ScrapedDocument:
    page = fetch(url)
    if page.status != 200:
        return ScrapedDocument(
            source_key=SOURCE_KEY, url=url, status="Failed", error=f"HTTP {page.status}"
        )

    return build_document(
        SOURCE_KEY,
        url,
        page,
        last_updated_at=first_attr(page, "meta[property='article:modified_time']", "content")
        or first_attr(page, "time", "datetime"),
    )

"""Fallback worker: document extraction with best-effort metadata."""

from __future__ import annotations

from .base import ScrapedDocument, build_document, fetch, first_attr


def scrape(url: str, source_key: str = "generic") -> ScrapedDocument:
    page = fetch(url)
    if page.status != 200:
        return ScrapedDocument(
            source_key=source_key, url=url, status="Failed",
            error=f"HTTP {page.status}",
        )
    return build_document(
        source_key,
        url,
        page,
        published_at=first_attr(page, "meta[property='article:published_time']", "content")
        or first_attr(page, "time", "datetime"),
        last_updated_at=first_attr(page, "meta[property='article:modified_time']", "content"),
    )

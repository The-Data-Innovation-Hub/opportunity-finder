"""
Scottish Medicines Consortium advice, via NHS Scotland's Knowledge Network
medicines-information library page.

SMC publishes advice per submission cycle with no public API or feed. The
library page is a link hub rather than an article, so its own text is thin --
the useful signal is which advice links it lists, which the content hash
tracks. Per-advice-document ingestion would mean following those links, which
is a deliberate follow-up rather than something to do silently on every run.
"""

from __future__ import annotations

from .base import ScrapedDocument, build_document, fetch, first_attr

SOURCE_KEY = "smc_advice"


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
        last_updated_at=first_attr(page, "meta[property='article:modified_time']", "content"),
    )

"""Funder pages for Opportunity Finder: a listing page or one scheme's page.

Fetched once a week and shared by every company's search, so Claude reads
the saved text instead of fetching the same pages for each company. Only
hosts on the funder catalogue's domains are fetched (funder_domains.json is
generated from Backend/Worker/Sources/catalogue.json).
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urljoin, urlparse

from .base import ScrapedDocument, content_hash, fetch, first_text, normalise_text

DOMAINS = json.loads((Path(__file__).with_name("funder_domains.json")).read_text())
MAX_LINKS = 200
# Listing pages are many cards, each often an <article>; the shared main-text
# extractor takes the first <article>, so funder pages use the page container.
CONTAINERS = ("main", "[role=main]", "#content", "body")
DROP = "script, style, noscript, nav, header, footer, svg, iframe, form"


def container(page):
    return next((found[0] for s in CONTAINERS if (found := page.css(s))), None)


def main_text(node) -> str:
    skip = {id(el) for el in node.css(DROP)}
    parts, seen = [], set()
    for element in node.css("*"):
        if id(element) in skip or element.find_ancestor(lambda el: id(el) in skip):
            continue
        text = (element.text or "").strip()
        if text and text not in seen:
            seen.add(text)
            parts.append(text)
    return normalise_text("\n".join(parts))


def allowed(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").removeprefix("www.")
    return parsed.scheme == "https" and any(host == d or host.endswith(f".{d}") for d in DOMAINS)


def page_links(page, base_url: str) -> list[dict]:
    """In-content links to catalogue sites: scheme pages hang off the listing."""
    node = container(page)
    if node is None:
        return []
    links, seen = [], set()
    for anchor in node.css("a"):
        href = urljoin(base_url, anchor.attrib.get("href") or "").split("#")[0]
        text = anchor.get_all_text(strip=True)
        if text and href not in seen and allowed(href):
            seen.add(href)
            links.append({"text": text, "url": href})
    return links[:MAX_LINKS]


def scrape(url: str, source_key: str = "funder_page") -> ScrapedDocument:
    if not allowed(url):
        raise ValueError(f"{urlparse(url).hostname} is not a catalogue funder site")
    page = fetch(url)
    if page.status != 200:
        return ScrapedDocument(source_key=source_key, url=url, status="Failed", error=f"HTTP {page.status}")
    node = container(page)
    text = main_text(node) if node is not None else ""
    return ScrapedDocument(
        source_key=source_key, url=url, status="Succeeded", title=first_text(page, "h1", "title"),
        content=text, content_length=len(text), content_hash=content_hash(text) if text else None,
        links=page_links(page, url),
    )

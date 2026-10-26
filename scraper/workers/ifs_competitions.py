"""Innovate UK Innovation Funding Service: every competition on the public
search, as structured rows (title, summary, eligibility, state, dates).

Read as a list rather than as page text so every competition reaches the
model as its own item it must accept or reject.
"""

from __future__ import annotations

import time
from urllib.parse import urljoin

from .base import ScrapedDocument, fetch, require_host

HOST = "apply-for-innovation-funding.service.gov.uk"
LISTING = f"https://{HOST}/competition/search"
MAX_PAGES = 10


def _text(nodes) -> str | None:
    return nodes[0].get_all_text(separator=" ", strip=True) if nodes else None


def parse_competitions(page) -> list[dict]:
    competitions = []
    for item in page.css("ul.govuk-list > li"):
        link = item.css("h2 a")
        if not link:
            continue
        blocks = item.css("div.wysiwyg-styles")
        dates = dict(zip([_text([d]) for d in item.css("dl dt")], [_text([d]) for d in item.css("dl dd")]))
        competitions.append({
            "title": link[0].get_all_text(strip=True),
            "url": urljoin(f"https://{HOST}", link[0].attrib.get("href") or ""),
            "summary": _text(blocks[:1]),
            "eligibility": _text(blocks[1:2]),
            "state": _text(item.css("h3")[1:2]),
            "opens": dates.get("Opens:"),
            "closes": dates.get("Closes:"),
        })
    return competitions


def scrape(url: str = LISTING, source_key: str = "ifs_competitions") -> ScrapedDocument:
    require_host(url, HOST)
    competitions: list[dict] = []
    for number in range(MAX_PAGES):
        if number:
            time.sleep(1)  # be polite: one page a second
        page = fetch(f"{LISTING}?page={number}")
        if page.status != 200:
            return ScrapedDocument(source_key=source_key, url=url, status="Failed", error=f"HTTP {page.status} on page {number}")
        found = [c for c in parse_competitions(page) if c["url"] not in {x["url"] for x in competitions}]
        if not found:
            break
        competitions.extend(found)
    return ScrapedDocument(source_key=source_key, url=url, status="Succeeded", title="Innovation Funding Service competitions",
                           notices=competitions, content_length=len(competitions))

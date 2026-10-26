"""Find a Grant (gov.uk): every UK government grant scheme in one listing.

No API, RSS or download exists for open grants; the /grants listing is
server-rendered GOV.UK HTML with a summary list per grant.
"""

from __future__ import annotations

from urllib.parse import urljoin

import time

from .base import ScrapedDocument, fetch, require_host

HOST = "www.find-government-grants.service.gov.uk"
LISTING = "https://www.find-government-grants.service.gov.uk/grants"
PAGE_SIZE = 50
MAX_PAGES = 20

FIELDS = {
    "Location": "location",
    "Funding organisation": "funder",
    "Who can apply": "who_can_apply",
    "How much you can get": "amount",
    "Total size of grant scheme": "total_size",
    "Opening date": "opening_date",
    "Closing date": "closing_date",
}


def parse_grants(page) -> list[dict]:
    grants = []
    for item in page.css("main li"):
        link = item.css("h2 a")
        if not link:
            continue
        grant = {
            "title": link[0].get_all_text(strip=True),
            "url": urljoin(f"https://{HOST}", link[0].attrib.get("href") or ""),
            "summary": (item.css("p")[0].get_all_text(strip=True) if item.css("p") else None),
        }
        for row in item.css("dl div"):
            label = row.css("dt")
            value = row.css("dd")
            if label and value and label[0].get_all_text(strip=True) in FIELDS:
                grant[FIELDS[label[0].get_all_text(strip=True)]] = value[0].get_all_text(strip=True)
        grants.append(grant)
    return grants


def scrape(url: str = LISTING, source_key: str = "find_a_grant") -> ScrapedDocument:
    require_host(url, HOST)
    grants: list[dict] = []
    for number in range(1, MAX_PAGES + 1):
        if number > 1:
            time.sleep(1)  # be polite: one page a second
        page = fetch(f"{LISTING}?limit={PAGE_SIZE}&page={number}")
        if page.status != 200:
            return ScrapedDocument(source_key=source_key, url=url, status="Failed", error=f"HTTP {page.status} on page {number}")
        found = parse_grants(page)
        new = [g for g in found if g["url"] not in {x["url"] for x in grants}]
        if not new:
            break
        grants.extend(new)
    return ScrapedDocument(source_key=source_key, url=url, status="Succeeded", title="Find a Grant",
                           notices=grants, content_length=len(grants))

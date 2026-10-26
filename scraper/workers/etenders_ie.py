"""etenders.gov.ie: the Republic of Ireland's national tender portal (OGP).

The "latest" quick search is a public, server-rendered displaytag table,
newest first, 10 rows a page; no API, RSS or OCDS feed exists. The worker
walks pages until it reaches notices published before `since` (or a page
cap), and returns the rows as they appear.
"""

from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import urljoin

import time

from .base import ScrapedDocument, fetch, require_host

HOST = "www.etenders.gov.ie"
LATEST = "https://www.etenders.gov.ie/epps/quickSearchAction.do?searchType=cftFTS&latest=true"
MAX_PAGES = 40
_PAGE_PARAM = re.compile(r"(d-\d+)-p=")


def _date(text: str) -> str | None:
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
        try:
            return datetime.strptime(text.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _value(text: str) -> float | None:
    cleaned = text.replace(",", "").strip()
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def parse_rows(page) -> list[dict]:
    headers = [th.get_all_text(strip=True) for th in page.css("table thead th")]
    rows = []
    for tr in page.css("table tbody tr"):
        cells = tr.css("td")
        if len(cells) != len(headers):
            continue
        by_name = dict(zip(headers, cells))
        title_cell = by_name.get("Title")
        link = title_cell.css("a")[0].attrib.get("href") if title_cell and title_cell.css("a") else None
        rows.append({
            "title": title_cell.get_all_text(strip=True) if title_cell else None,
            "reference": by_name["Resource ID"].get_all_text(strip=True) if "Resource ID" in by_name else None,
            "buyer": by_name["CA"].get_all_text(strip=True) if "CA" in by_name else None,
            "published_on": _date(by_name["Date published"].get_all_text(strip=True)) if "Date published" in by_name else None,
            "closing_date": _date(by_name["Tenders Submission Deadline"].get_all_text(strip=True)) if "Tenders Submission Deadline" in by_name else None,
            "procedure": by_name["Procedure"].get_all_text(strip=True) if "Procedure" in by_name else None,
            "status": by_name["Status"].get_all_text(strip=True) if "Status" in by_name else None,
            "estimated_value_eur": _value(by_name["Estimated value"].get_all_text(strip=True)) if "Estimated value" in by_name else None,
            "url": urljoin(f"https://{HOST}", link) if link else None,
        })
    return rows


def _page_url(page, number: int) -> str | None:
    for anchor in page.css("table thead a"):
        match = _PAGE_PARAM.search(anchor.attrib.get("href") or "")
        if match:
            return f"{LATEST}&{match.group(1)}-p={number}"
    return None


def scrape(url: str = LATEST, source_key: str = "etenders_ie_latest", since: str | None = None) -> ScrapedDocument:
    require_host(url, HOST)
    notices: list[dict] = []
    page = fetch(url)
    for number in range(1, MAX_PAGES + 1):
        if page.status != 200:
            return ScrapedDocument(source_key=source_key, url=url, status="Failed", error=f"HTTP {page.status} on page {number}")
        rows = parse_rows(page)
        notices.extend(rows)
        oldest = min((r["published_on"] for r in rows if r["published_on"]), default=None)
        if not rows or (since and oldest and oldest < since):
            break
        next_url = _page_url(page, number + 1)
        if not next_url:
            break
        time.sleep(1)  # be polite: one page a second
        page = fetch(next_url)
    if since:
        notices = [n for n in notices if not n["published_on"] or n["published_on"] >= since]
    return ScrapedDocument(source_key=source_key, url=url, status="Succeeded", title="eTenders latest notices",
                           notices=notices, content_length=len(notices))

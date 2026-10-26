"""
Shared fetch/clean/extract machinery for guidance-source workers.

Deliberately document-level only: title, canonical URL, publication and
last-updated dates, cleaned main text, and a content hash. Clinical fields
(medicine names, drug classes, safety issue type, urgency) are NOT extracted
here -- they cannot be derived reliably from HTML selectors, and emitting
guessed clinical attributes into a patient-safety pipeline would give
unreliable data the appearance of structured fact. Classification is a
separate, reviewable stage downstream.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone

import certifi
from scrapling import Fetcher

# Chrome-like default; scrapling sets a sensible UA itself, this is belt and braces.
DEFAULT_TIMEOUT = 30

# Elements that carry no document content and change constantly (nav highlights,
# cookie banners, "related news" rails). Stripping them is what makes the content
# hash stable enough for change detection to mean something.
BOILERPLATE_SELECTORS = (
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "iframe",
    "svg",
    "[role=navigation]",
    "[role=banner]",
    "[role=contentinfo]",
    "[role=search]",
    ".cookie-banner",
    "#cookie-banner",
    ".skip-link",
)

# Preferred main-content containers, most specific first.
MAIN_CONTENT_SELECTORS = ("article", "main", "[role=main]", "#content", ".content", "body")

_WHITESPACE_RE = re.compile(r"[ \t\r\f\v]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")


@dataclass
class ScrapedDocument:
    source_key: str
    url: str
    status: str  # "Succeeded" | "Failed"
    title: str | None = None
    published_at: str | None = None
    last_updated_at: str | None = None
    content: str | None = None
    content_length: int | None = None
    content_hash: str | None = None
    # Set only by catalogue-style workers (RightBreathe); guidance workers
    # leave it None, since inferring structured clinical attributes from prose
    # is a classification concern, not a scraping one.
    products: list[dict] | None = None
    # Set only by listing workers (eTenders, Find a Grant): one dict per
    # opportunity row, fields exactly as the listing shows them.
    notices: list[dict] | None = None
    # Set only by the funder_page worker: in-content links to catalogue sites.
    links: list[dict] | None = None
    error: str | None = None
    fetched_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict:
        return asdict(self)


def require_host(url: str, *hosts: str) -> None:
    """Listing workers only fetch their own site: refuse anything else."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in hosts:
        raise ValueError(f"{parsed.hostname} is not handled by this worker")


def normalise_text(text: str) -> str:
    """Collapse runs of horizontal whitespace and excess blank lines.

    Without this, trivial reflow in the publisher's HTML changes the hash and
    every run reports a false change.
    """
    lines = [_WHITESPACE_RE.sub(" ", line).strip() for line in text.splitlines()]
    return _BLANKLINES_RE.sub("\n\n", "\n".join(lines)).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fetch(url: str, timeout: int = DEFAULT_TIMEOUT):
    """Fetch a page with scrapling's plain HTTP fetcher.

    Deliberately NOT StealthyFetcher/DynamicFetcher: every source currently
    routed to this service serves static server-rendered HTML over plain HTTP
    (verified against all three), so a browser engine would add hundreds of
    megabytes to the image and seconds per fetch for no gain. Sources that
    genuinely need a browser should opt in explicitly rather than making
    everything pay for it.
    """
    # Verify against certifi's Mozilla CA bundle: curl_cffi's built-in bundle
    # lacks some current roots (e.g. Sectigo R46, used by enterprise-ireland.com).
    return Fetcher.get(url, timeout=timeout, verify=certifi.where())


def extract_main_text(page) -> str:
    """Return the page's main textual content with boilerplate removed."""
    for selector in MAIN_CONTENT_SELECTORS:
        found = page.css(selector)
        if not found:
            continue
        container = found[0]
        parts: list[str] = []
        for element in container.css("*"):
            # Skip anything living inside boilerplate; cheaper than mutating
            # the tree, and scrapling's Selector is read-oriented.
            if _is_boilerplate(element):
                continue
            text = element.text
            if text:
                stripped = text.strip()
                if stripped:
                    parts.append(stripped)
        if parts:
            return normalise_text("\n".join(_dedupe_preserving_order(parts)))
        text = container.get_all_text(strip=True)
        if text:
            return normalise_text(text)
    return ""


def _is_boilerplate(element) -> bool:
    tag = (getattr(element, "tag", "") or "").lower()
    if tag in {"script", "style", "noscript", "nav", "header", "footer", "aside", "svg", "iframe"}:
        return True
    for ancestor_tag in ("nav", "header", "footer", "aside"):
        if element.find_ancestor(lambda el: (getattr(el, "tag", "") or "").lower() == ancestor_tag):
            return True
    return False


def _dedupe_preserving_order(parts: list[str]) -> list[str]:
    """Nested elements yield the same text repeatedly; keep first occurrence."""
    seen: set[str] = set()
    out: list[str] = []
    for part in parts:
        if part not in seen:
            seen.add(part)
            out.append(part)
    return out


def first_text(page, *selectors: str) -> str | None:
    for selector in selectors:
        found = page.css(selector)
        if found:
            text = found[0].get_all_text(strip=True)
            if text:
                return text
    return None


def first_attr(page, selector: str, attr: str) -> str | None:
    found = page.css(selector)
    if found:
        value = found[0].attrib.get(attr)
        if value:
            return str(value).strip()
    return None


def build_document(source_key: str, url: str, page, title=None, published_at=None,
                   last_updated_at=None) -> ScrapedDocument:
    text = extract_main_text(page)
    return ScrapedDocument(
        source_key=source_key,
        url=url,
        status="Succeeded",
        title=title or first_text(page, "h1", "title"),
        published_at=published_at,
        last_updated_at=last_updated_at,
        content=text,
        content_length=len(text),
        content_hash=content_hash(text) if text else None,
    )

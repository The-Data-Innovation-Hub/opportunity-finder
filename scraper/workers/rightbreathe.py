"""
RightBreathe inhaler catalogue.

Unlike the guidance sources, structured extraction IS appropriate here: these
are product-catalogue attributes (name, manufacturer, price, device type)
stated plainly in the markup, not clinical judgements inferred from prose. The
distinction that matters is whether a field is *read* from the page or
*guessed* about it.

Replaces the previous Firecrawl-based scrape, which regex-scanned a 3000-char
window around each product link and guessed names from headings or URL slugs.
RightBreathe renders its results server-side in a clean repeating container,
so selector-based extraction is both simpler and considerably more reliable --
and needs no browser engine despite the old Firecrawl call performing eight
scroll actions.
"""

from __future__ import annotations

import re

from .base import ScrapedDocument, build_document, fetch

SOURCE_KEY = "rightbreathe_inhalers"

ITEM_SELECTOR = ".SearchResults-item"
TITLE_SELECTOR = ".MedicineDeviceSummary-title"
SUBTITLE_SELECTOR = ".MedicineDeviceSummary-subtitle"
LINK_SELECTOR = 'a[href*="/medicines/"]'

# "Eklira 322 Genuair (Zentiva Pharma UK Ltd) 60 dose" -> manufacturer in parens.
_MANUFACTURER_RE = re.compile(r"\(([^)]+)\)")
_PRICE_RE = re.compile(r"£\s*([\d.]+)")
_DEVICE_RE = re.compile(
    r"(Dry powder inhaler \(DPI\)"
    r"|Pressurised aerosol inhaler \(MDI\)"
    r"|Multi-dose solution for inhalation"
    r"|Soft mist inhaler)",
    re.IGNORECASE,
)
# Inhaler pharmacology classes as RightBreathe labels them, longest first so
# "LAMA + LABA" wins over a bare "LAMA".
_CLASS_TOKENS = (
    "ICS + LABA + LAMA",
    "LAMA + LABA",
    "ICS + LABA",
    "LABA",
    "LAMA",
    "SABA",
    "SAMA",
    "ICS",
    "Cromoglicate",
)


def _text(node) -> str:
    return (node.get_all_text(strip=True) or "").strip() if node is not None else ""


def _first(container, selector):
    found = container.css(selector)
    return found[0] if found else None


def _extract_product(item) -> dict | None:
    link_el = _first(item, LINK_SELECTOR)
    product_url = link_el.attrib.get("href") if link_el is not None else None

    name = _text(_first(item, TITLE_SELECTOR))
    if not name and link_el is not None:
        name = _text(link_el)
    if not name:
        return None

    active_ingredient = _text(_first(item, SUBTITLE_SELECTOR)) or None

    block = _text(item)
    manufacturer_match = _MANUFACTURER_RE.search(name)
    price_match = _PRICE_RE.search(block)
    device_match = _DEVICE_RE.search(block)

    drug_class = None
    for token in _CLASS_TOKENS:
        if re.search(rf"(?<![A-Za-z+]){re.escape(token)}(?![A-Za-z])", block):
            drug_class = token
            break

    return {
        "name": name,
        "manufacturer": manufacturer_match.group(1).strip() if manufacturer_match else None,
        "activeIngredient": active_ingredient,
        "drugClass": drug_class,
        "deviceType": device_match.group(1) if device_match else None,
        "pricePer30Days": f"£{price_match.group(1)}" if price_match else None,
        "productUrl": product_url,
    }


def scrape(url: str) -> ScrapedDocument:
    page = fetch(url, timeout=45)
    if page.status != 200:
        return ScrapedDocument(
            source_key=SOURCE_KEY, url=url, status="Failed", error=f"HTTP {page.status}"
        )

    products: list[dict] = []
    seen_urls: set[str] = set()
    for item in page.css(ITEM_SELECTOR):
        product = _extract_product(item)
        if not product:
            continue
        # The catalogue lists each medicine once; guard anyway so a layout
        # change that nests containers can't silently double-count.
        key = product["productUrl"] or product["name"]
        if key in seen_urls:
            continue
        seen_urls.add(key)
        products.append(product)

    if not products:
        return ScrapedDocument(
            source_key=SOURCE_KEY,
            url=url,
            status="Failed",
            error=(
                f"No products parsed from {len(page.css(ITEM_SELECTOR))} result containers "
                "-- RightBreathe's markup may have changed."
            ),
        )

    document = build_document(SOURCE_KEY, url, page)
    document.products = products
    return document

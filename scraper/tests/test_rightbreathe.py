from __future__ import annotations

from tests.conftest import FakeResponse
from workers import rightbreathe


def _page(items_html: str) -> str:
    return f"<html><body><div class='SearchResults'>{items_html}</div></body></html>"


def test_scrape_extracts_full_product_fields(monkeypatch):
    html = _page(
        """
        <div class="SearchResults-item">
          <a href="/medicines/eklira-322-genuair">
            <div class="MedicineDeviceSummary-title">Eklira 322 Genuair (Zentiva Pharma UK Ltd) 60 dose</div>
            <div class="MedicineDeviceSummary-subtitle">Aclidinium bromide</div>
          </a>
          <div>Dry powder inhaler (DPI)</div>
          <div>&#163;29.99</div>
          <div>LAMA</div>
        </div>
        """
    )
    monkeypatch.setattr(rightbreathe, "fetch", lambda url, timeout=45: FakeResponse(html))

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert doc.status == "Succeeded"
    assert doc.products is not None and len(doc.products) == 1
    product = doc.products[0]
    assert product["name"] == "Eklira 322 Genuair (Zentiva Pharma UK Ltd) 60 dose"
    assert product["manufacturer"] == "Zentiva Pharma UK Ltd"
    assert product["activeIngredient"] == "Aclidinium bromide"
    assert product["deviceType"] == "Dry powder inhaler (DPI)"
    assert product["pricePer30Days"] == "£29.99"
    assert product["drugClass"] == "LAMA"
    assert product["productUrl"] == "/medicines/eklira-322-genuair"


def test_combination_drug_class_token_wins_over_its_component_tokens(monkeypatch):
    html = _page(
        """
        <div class="SearchResults-item">
          <a href="/medicines/duaklir-genuair">
            <div class="MedicineDeviceSummary-title">Duaklir Genuair (AstraZeneca UK Ltd) 60 dose</div>
            <div class="MedicineDeviceSummary-subtitle">Aclidinium bromide / formoterol fumarate</div>
          </a>
          <div>Dry powder inhaler (DPI)</div>
          <div>&#163;45.50</div>
          <div>LAMA + LABA</div>
        </div>
        """
    )
    monkeypatch.setattr(rightbreathe, "fetch", lambda url, timeout=45: FakeResponse(html))

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert doc.products[0]["drugClass"] == "LAMA + LABA"


def test_scrape_deduplicates_by_product_url(monkeypatch):
    item = """
        <div class="SearchResults-item">
          <a href="/medicines/eklira-322-genuair">
            <div class="MedicineDeviceSummary-title">Eklira 322 Genuair (Zentiva Pharma UK Ltd) 60 dose</div>
          </a>
        </div>
        """
    html = _page(item + item)
    monkeypatch.setattr(rightbreathe, "fetch", lambda url, timeout=45: FakeResponse(html))

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert len(doc.products) == 1


def test_scrape_skips_items_with_no_name(monkeypatch):
    html = _page(
        """
        <div class="SearchResults-item">
          <span>No link, no title, nothing usable here.</span>
        </div>
        <div class="SearchResults-item">
          <a href="/medicines/real-product">
            <div class="MedicineDeviceSummary-title">Real Product (Some Ltd) 30 dose</div>
          </a>
        </div>
        """
    )
    monkeypatch.setattr(rightbreathe, "fetch", lambda url, timeout=45: FakeResponse(html))

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert len(doc.products) == 1
    assert doc.products[0]["name"] == "Real Product (Some Ltd) 30 dose"


def test_scrape_falls_back_to_link_text_when_title_element_missing(monkeypatch):
    html = _page(
        """
        <div class="SearchResults-item">
          <a href="/medicines/link-text-product">Link Text Product Name</a>
        </div>
        """
    )
    monkeypatch.setattr(rightbreathe, "fetch", lambda url, timeout=45: FakeResponse(html))

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert doc.products[0]["name"] == "Link Text Product Name"


def test_scrape_fails_when_no_products_can_be_parsed(monkeypatch):
    html = _page(
        """
        <div class="SearchResults-item"><span>Nothing extractable.</span></div>
        """
    )
    monkeypatch.setattr(rightbreathe, "fetch", lambda url, timeout=45: FakeResponse(html))

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert doc.status == "Failed"
    assert "No products parsed" in doc.error
    assert doc.products is None


def test_scrape_reports_failure_on_non_200(monkeypatch):
    monkeypatch.setattr(
        rightbreathe, "fetch", lambda url, timeout=45: FakeResponse("", status=502)
    )

    doc = rightbreathe.scrape("https://example.invalid/search")

    assert doc.status == "Failed"
    assert doc.error == "HTTP 502"

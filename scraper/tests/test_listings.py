"""Opportunity Finder listing workers, parsed from saved public pages (offline)."""

from pathlib import Path

import pytest
from scrapling import Selector

from workers import etenders_ie, find_a_grant
from workers.base import require_host

FIXTURES = Path(__file__).parent / "fixtures"


def _page(name):
    return Selector((FIXTURES / name).read_text())


def test_etenders_rows_have_title_buyer_dates_and_link():
    rows = etenders_ie.parse_rows(_page("etenders_ie_latest.html"))
    assert len(rows) == 10
    first = rows[0]
    assert first["title"].startswith("Tender for the provision of Physical Occupational Therapy")
    assert first["buyer"] == "Irish Prison Service"
    assert first["published_on"] == "2026-10-22"
    assert first["closing_date"] == "2026-11-16"
    assert first["estimated_value_eur"] == 250000.0
    assert first["url"] == "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=9341325"


def test_etenders_next_page_url_uses_the_tables_own_paging_parameter():
    url = etenders_ie._page_url(_page("etenders_ie_latest.html"), 2)
    assert url.startswith(etenders_ie.LATEST) and url.endswith("-p=2")


def test_find_a_grant_parses_summary_fields():
    grants = find_a_grant.parse_grants(_page("find_a_grant.html"))
    assert len(grants) == 10
    hs2 = next(g for g in grants if g["title"].startswith("Community and Environment Fund"))
    assert hs2["funder"] == "HS2 Ltd"
    assert hs2["amount"] == "From £1 to £250,000"
    assert hs2["url"].startswith("https://www.find-government-grants.service.gov.uk/grants/")


@pytest.mark.parametrize("url", [
    "https://evil.example/epps/quickSearchAction.do",
    "http://www.etenders.gov.ie/epps/quickSearchAction.do",
    "https://www.etenders.gov.ie.evil.example/",
])
def test_listing_workers_refuse_other_hosts(url):
    with pytest.raises(ValueError):
        require_host(url, etenders_ie.HOST)


def test_ifs_competitions_have_title_summary_state_and_dates():
    from workers import ifs_competitions
    rows = ifs_competitions.parse_competitions(_page("ifs_competitions.html"))
    assert len(rows) == 10
    first = rows[0]
    assert first["title"] == "Healthy Soils and Water for a Sustainable Environment"
    assert first["url"].startswith("https://apply-for-innovation-funding.service.gov.uk/competition/2604/overview/")
    assert first["summary"].startswith("UK registered businesses can apply for a share of up to £28 million")
    assert "collaborations only" in first["eligibility"]
    assert first["state"] == "Opening soon"
    assert (first["opens"], first["closes"]) == ("19 November 2026", "28 January 2027")

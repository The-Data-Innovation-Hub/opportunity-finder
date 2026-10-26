"""funder_page worker: catalogue-only hosts and in-content links (offline)."""

import pytest
from scrapling import Selector

from workers import funder_page

PAGE = """<html><body><nav><a href="/menu">Menu</a></nav><main>
<h1>Funding support</h1><p>Grants for innovation.</p>
<a href="/support-for-business/innovation-vouchers">Innovation Vouchers</a>
<a href="https://intertradeireland.com/innovation/innovation-boost#apply">Innovation Boost</a>
<a href="https://example.com/elsewhere">Elsewhere</a>
<a href="/support-for-business/innovation-vouchers">Innovation Vouchers again</a>
</main></body></html>"""


def test_only_catalogue_hosts_over_https_are_allowed():
    assert funder_page.allowed("https://www.investni.com/x")
    assert funder_page.allowed("https://innovations.hscni.net/news/funding/")
    assert not funder_page.allowed("http://www.investni.com/x")
    assert not funder_page.allowed("https://investni.com.evil.example/x")
    assert not funder_page.allowed("https://169.254.169.254/latest/meta-data")


def test_scrape_refuses_other_hosts():
    with pytest.raises(ValueError):
        funder_page.scrape("https://example.com/")


def test_links_are_in_content_catalogue_links_without_duplicates():
    links = funder_page.page_links(Selector(PAGE), "https://www.investni.com/support-for-business/funding-support")
    assert links == [
        {"text": "Innovation Vouchers", "url": "https://www.investni.com/support-for-business/innovation-vouchers"},
        {"text": "Innovation Boost", "url": "https://intertradeireland.com/innovation/innovation-boost"},
    ]

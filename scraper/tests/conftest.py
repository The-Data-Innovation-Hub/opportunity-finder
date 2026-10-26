"""
Shared test fixtures for the guidance-scraper worker suite.

Every worker's `fetch()` makes a real network call via scrapling's
`Fetcher.get()`. These tests never touch the network: they monkeypatch each
worker module's `fetch` to return a `FakeResponse` wrapping a *real*
`scrapling.Selector` built from a static HTML fixture string. Only the HTTP
layer is faked -- HTML parsing and text extraction run through the actual
scrapling code the service depends on, at the pinned version in
requirements.txt, so these tests exercise the real extraction logic, not a
hand-rolled substitute for it.
"""

from __future__ import annotations

from scrapling import Selector


class FakeResponse:
    """Stands in for scrapling's Fetcher.get() return value.

    Only `.status` and `.css(...)` are faked (the HTTP-layer surface every
    worker actually touches on the top-level response); `.css(...)` delegates
    to a real Selector, so every element it returns is a genuine scrapling
    node with real `.css`/`.get_all_text`/`.attrib`/`.text`/`.find_ancestor`
    behaviour.
    """

    def __init__(self, html: str, status: int = 200):
        self.status = status
        self._selector = Selector(html)

    def css(self, selector: str):
        return self._selector.css(selector)

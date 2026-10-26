from __future__ import annotations

from scrapling import Selector

from workers.base import (
    build_document,
    content_hash,
    extract_main_text,
    first_attr,
    first_text,
    normalise_text,
)


def test_normalise_text_collapses_horizontal_whitespace():
    assert normalise_text("hello    world\t\tfoo") == "hello world foo"


def test_normalise_text_collapses_excess_blank_lines():
    text = "para one\n\n\n\n\npara two"
    assert normalise_text(text) == "para one\n\npara two"


def test_normalise_text_strips_leading_and_trailing_whitespace():
    assert normalise_text("  \n  hello  \n  ") == "hello"


def test_content_hash_is_deterministic_and_sensitive_to_change():
    a = content_hash("some content")
    b = content_hash("some content")
    c = content_hash("some different content")
    assert a == b
    assert a != c
    assert len(a) == 64  # sha256 hex digest


def test_extract_main_text_strips_boilerplate_and_keeps_article_body():
    html = """
    <html><body>
      <nav>Site navigation, not content</nav>
      <header>Site header</header>
      <article>
        <h1>Real Title</h1>
        <p>First real paragraph.</p>
        <p>Second real paragraph.</p>
      </article>
      <footer>Site footer</footer>
    </body></html>
    """
    text = extract_main_text(Selector(html))
    assert "Real Title" in text
    assert "First real paragraph." in text
    assert "Second real paragraph." in text
    assert "Site navigation" not in text
    assert "Site header" not in text
    assert "Site footer" not in text


def test_extract_main_text_falls_back_through_container_selectors():
    # No <article>/<main>/[role=main]/#content/.content -- must fall back to <body>.
    html = "<html><body><p>Only body content here.</p></body></html>"
    text = extract_main_text(Selector(html))
    assert "Only body content here." in text


def test_extract_main_text_returns_empty_string_for_empty_document():
    html = "<html><body></body></html>"
    assert extract_main_text(Selector(html)) == ""


def test_first_text_returns_first_matching_selector_in_order():
    html = "<html><body><h1>Heading</h1><title>Doc Title</title></body></html>"
    sel = Selector(html)
    assert first_text(sel, "h1", "title") == "Heading"
    assert first_text(sel, "title", "h1") == "Doc Title"


def test_first_text_returns_none_when_nothing_matches():
    html = "<html><body><p>no heading here</p></body></html>"
    assert first_text(Selector(html), "h1", "title") is None


def test_first_attr_reads_the_named_attribute():
    html = '<html><body><meta property="article:modified_time" content="2026-01-02T00:00:00Z"></body></html>'
    value = first_attr(
        Selector(html), "meta[property='article:modified_time']", "content"
    )
    assert value == "2026-01-02T00:00:00Z"


def test_first_attr_returns_none_when_selector_does_not_match():
    html = "<html><body><p>nothing to match</p></body></html>"
    assert first_attr(Selector(html), "meta[property='x']", "content") is None


def test_build_document_populates_title_content_length_and_hash():
    html = """
    <html><body><article>
      <h1>Doc Heading</h1>
      <p>Body text.</p>
    </article></body></html>
    """
    doc = build_document("some_source", "https://example.invalid/page", Selector(html))
    assert doc.source_key == "some_source"
    assert doc.url == "https://example.invalid/page"
    assert doc.status == "Succeeded"
    assert doc.title == "Doc Heading"
    assert doc.content is not None and "Body text." in doc.content
    assert doc.content_length == len(doc.content)
    assert doc.content_hash == content_hash(doc.content)


def test_build_document_prefers_explicit_title_over_page_heading():
    html = "<html><body><article><h1>Page Heading</h1></article></body></html>"
    doc = build_document(
        "some_source", "https://example.invalid/page", Selector(html), title="Explicit Title"
    )
    assert doc.title == "Explicit Title"


def test_build_document_leaves_hash_and_length_none_for_empty_content():
    html = "<html><body></body></html>"
    doc = build_document("some_source", "https://example.invalid/page", Selector(html))
    assert doc.content == ""
    assert doc.content_length == 0
    assert doc.content_hash is None

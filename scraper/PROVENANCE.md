# Provenance

Copied on 22 Oct 2026 from `screen-clinical-main/guidance-scraper` at commit
`6db7ac7b` (last change to that folder, 7 Sep 2026). Decision: same code,
deployed separately as its own Container App (Brendan, 22 Oct 2026). Do not
point this service at Screen Clinical's `sc-dev-scraper`, or the reverse.

Added for Opportunity Finder:
- `workers/etenders_ie.py`: etenders.gov.ie latest notices (public listing).
- `workers/find_a_grant.py`: gov.uk Find a Grant listing.
- `ScrapedDocument.notices`, `require_host`, and the optional `since` field on `/scrape`.

The Screen Clinical guidance workers (sps, gphc, smc, rightbreathe) are kept
unchanged so fixes can be compared and ported in either direction.

No browser fetcher: eTendersNI's listing sits behind a CAPTCHA, which this
service must not bypass, and the sites that return 403 to scripts are
deliberately blocking automated access (DEC-006, 22 Oct 2026).

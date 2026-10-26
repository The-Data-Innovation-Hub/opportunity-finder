"""
Opportunity Finder scraper service (copied from the Screen Clinical guidance
scraper; see PROVENANCE.md).

Guidance scraper service.

A small internal HTTP wrapper around the per-source Scrapling workers. The
Screen Clinical Node backend calls this for guidance sources whose
ingestion_method is 'scrapling'; sources with a publisher feed or a licensed
API never reach here.

Scrape permission is enforced on the Node side (guidance_source.allowed_to_scrape,
see resolveSkipReason in backend/API/GuidanceSources.mjs). This service is the
mechanism, not the policy, and is deliberately not exposed publicly -- it runs
on internal ingress inside the Container Apps environment, with a shared-secret
header as defence in depth.
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

import workers

app = FastAPI(title="Opportunity Finder Scraper", version="1.0.0")

SHARED_SECRET = os.environ.get("SCRAPER_SHARED_SECRET", "")


class ScrapeRequest(BaseModel):
    source_key: str = Field(..., description="Worker key, e.g. sps_medication_safety_update")
    url: str = Field(..., description="URL to fetch")
    since: str | None = Field(None, description="Listing workers: ISO date; stop paging at notices published before it")


def _authorise(provided: str | None) -> None:
    """Reject unauthenticated calls when a secret is configured.

    If no secret is set the service is open, which is only acceptable because
    it runs on internal ingress. Configure SCRAPER_SHARED_SECRET in any
    environment where that is not guaranteed.
    """
    if not SHARED_SECRET:
        return
    if provided != SHARED_SECRET:
        raise HTTPException(status_code=401, detail="Invalid or missing scraper secret")


@app.get("/health")
def health() -> dict:
    return {
        "status": "healthy",
        "workers": workers.registered_keys(),
        "auth_required": bool(SHARED_SECRET),
    }


@app.post("/scrape")
def scrape(request: ScrapeRequest, x_scraper_secret: str | None = Header(default=None)) -> dict:
    _authorise(x_scraper_secret)
    try:
        # Only listing workers take `since`; keep the original two-argument call otherwise.
        extra = {"since": request.since} if request.since else {}
        document = workers.scrape(request.source_key, request.url, **extra)
    except Exception as exc:  # noqa: BLE001 -- surface the reason, never 500 silently
        return {
            "source_key": request.source_key,
            "url": request.url,
            "status": "Failed",
            "error": f"{type(exc).__name__}: {exc}",
        }
    return document.to_dict()

# Guidance scraper service (Python/Scrapling), deployed as a second Container
# App alongside sc-dev-api. Mirrors the backend Dockerfile's shape: install
# deps first for layer caching, then copy source.
#
# Slim (not alpine): lxml/curl_cffi ship manylinux wheels for glibc, so alpine
# would force a lengthy source build of both for no size benefit.
FROM python:3.12-slim

WORKDIR /app

# curl is used by the container's own healthcheck; no browser packages are
# installed because no browser fetcher is used.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run as a non-root user: this service fetches and parses untrusted remote HTML.
RUN useradd --create-home --uid 10001 scraper && chown -R scraper:scraper /app
USER scraper

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]

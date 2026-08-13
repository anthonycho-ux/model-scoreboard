# Nous Portal Dashboard

Interactive dashboard for the Nous Portal model catalog. Holds your API key
server-side, proxies the live catalog, and renders a filterable, sortable
table with caching-aware per-call cost.

## Run

```bash
cd /Users/acmac/Projects/nous-portal-dashboard
NOUS_API_KEY="sk-nous-..." node server.mjs
# open http://127.0.0.1:8347
```

## Features

- Live catalog from GET /v1/models, refreshed every 2 minutes
- Filter by search, provider, reasoning-only
- Sort by cache read, raw input, output, or cost per call
- Cost-per-call slider: adjust cached / fresh / output token mix
- Bar chart on cache-read price; your standard models highlighted
- Key stays in the server process, never in the browser

## Notes

- The portal has no popularity/trending field. Recency (created) and the
  ~latest alias pointers are the honest proxies.
- Cache read dominates cost for large cached system prompts, so sorting by
  cache read is the economically meaningful view for a caching-heavy workload.

# Nous Portal Dashboard

Interactive dashboard for the Nous Portal model catalog. Holds your API key
server-side, proxies the live catalog, and renders a filterable, sortable
table with caching-aware per-call cost. Runs as a login service via launchd.

## Run (manual)

```bash
cd /Users/acmac/Projects/nous-portal-dashboard
NOUS_API_KEY="sk-nous-..." node server.mjs
# open http://127.0.0.1:8347
```

## Run (shipped, starts at login)

The server is managed by launchd:

- Plist: `~/Library/LaunchAgents/com.hermes.nous-portal-dashboard.plist`
- Wrapper: `run-server.sh` loads the key from the gitignored `.env` (chmod 600)
- Behavior: `RunAtLoad` + `KeepAlive`, so it starts at login and is respawned
  if it dies. Survives reboot.
- Logs: `/tmp/nous-portal-dashboard.serve.log` and `.serve.err.log`

Restart after a code change:

```bash
launchctl kickstart -k gui/$(id -u)/com.hermes.nous-portal-dashboard
```

## Features

- Live catalog from GET /v1/models, refreshed every 2 minutes
- Filter by search, provider, reasoning-only
- Sort by cache read, raw input, output, or cost per call
- Cost-per-call slider: adjust cached / fresh / output token mix
- Bar chart on cache-read price; your standard models highlighted
- Key stays in the server process, never in the browser
- Scoreboard ranks by intelligence over cost using live artificial_analysis
  benchmarks (composite / intelligence / coding / agentic), 103+ models

## Apply a model to routing (yes-gate)

The scoreboard has an Apply button per row. Clicking it stages the model
server-side and returns a token; nothing is written yet. The confirm dialog
shows the model, metric, score, cost per call, and score per cost. Only after
you click Yes does the server:

1. Back up the current settings to `~/.aside/backups/nous-apply/`
2. Write `defaultModel` into `~/.aside/u/0/settings.json` (provider
   `nous-portal`, model id from the live catalog)

API:

- `GET  /api/apply/status` - current routing model and any pending apply
- `POST /api/apply {model, metric}` - stage; returns a token, writes nothing
- `POST /api/apply/confirm {token}` - apply the staged model, with backup

## Command Code column

`cmd-usage.mjs` probes the logged-in Command Code session against the live
Provider API. When the session is valid it reports the real model catalog
(53 models at last check). Billed per-request cost is only reported where
Studio exposes it; there is no historical usage API, so the adapter never
invents a per-request number for Command Code. Grok, Claude, and Kimi are
flat-fee subscriptions and are marked as such.

## Notes

- The portal has no popularity/trending field. Recency (created) and the
  ~latest alias pointers are the honest proxies.
- Cache read dominates cost for large cached system prompts, so sorting by
  cache read is the economically meaningful view for a caching-heavy workload.
- Intelligence source: artificial_analysis benchmarks from the live catalog.
  No score is invented.

#!/bin/bash
# Launch wrapper for the Nous Portal dashboard server.
# Loads NOUS_API_KEY from the gitignored .env (chmod 600) and execs the server.
# Used by launchd (com.hermes.nous-portal-dashboard) so the key never appears
# in the plist or the browser; it stays in this server-side file.
cd /Users/acmac/Projects/nous-portal-dashboard || exit 1
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
exec /Users/acmac/.hermes/node/bin/node server.mjs

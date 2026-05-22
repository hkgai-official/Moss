#!/usr/bin/env bash
# Install MOSS evolution control surface. Idempotent — safe to re-run.
#
# This script wires the MOSS self-evolution capability into a host:
#  1. Symlinks the moss CLI to /usr/local/bin/moss (so the container bind-mount finds it)
#  2. Places evolution.md into $MOSS_DATA_DIR/moss-capability/ (so the agent can Read it)
#  3. Merges the 3 MOSS hook mappings into OpenClaw's settings.json
#  4. Sets tools.exec.host=gateway in openclaw.json (so agent can run moss commands)
#  5. Registers the periodic auto-scan cron job in OpenClaw
#
# Prerequisites:
#  - $MOSS_DATA_DIR set in the environment
#  - moss-gateway docker container running (for cron registration)
#  - jq installed (for settings.json merge and openclaw.json update)

set -euo pipefail

REPO_ROOT="${MOSS_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
: "${MOSS_DATA_DIR:?MOSS_DATA_DIR must be set}"

CLI_SRC="$REPO_ROOT/host-daemon/src/cli/moss"
CLI_LINK="/usr/local/bin/moss"
CAPABILITY_SRC="$REPO_ROOT/host-daemon/src/cli/moss_capability/evolution.md"
CAPABILITY_DST_DIR="$MOSS_DATA_DIR/moss-capability"
HOOK_MAPPINGS_SRC="$REPO_ROOT/host-daemon/scripts/moss-hook-mappings.json"

# ----------------------------------------------------------------------------
# 1. Symlink CLI to /usr/local/bin (host-side convenience; container gets it
#    via docker-compose bind-mount independently, so failure here is non-fatal)
# ----------------------------------------------------------------------------
chmod +x "$CLI_SRC"
if [ -L "$CLI_LINK" ] && [ "$(readlink "$CLI_LINK")" = "$CLI_SRC" ]; then
  echo "[1/5] CLI symlink already in place: $CLI_LINK -> $CLI_SRC"
elif ln -sf "$CLI_SRC" "$CLI_LINK" 2>/dev/null; then
  echo "[1/5] Linked $CLI_LINK -> $CLI_SRC"
elif sudo -n ln -sf "$CLI_SRC" "$CLI_LINK" 2>/dev/null; then
  echo "[1/5] Linked $CLI_LINK -> $CLI_SRC (via sudo)"
else
  echo "[1/5] SKIP: could not write $CLI_LINK (no passwordless sudo)."
  echo "       Container still gets the CLI via docker-compose bind-mount."
  echo "       For host-side use: sudo ln -sf $CLI_SRC $CLI_LINK"
fi

# ----------------------------------------------------------------------------
# 2. Place evolution.md
# ----------------------------------------------------------------------------
echo "[2/5] Placing evolution.md at $CAPABILITY_DST_DIR/evolution.md"
mkdir -p "$CAPABILITY_DST_DIR"
cp "$CAPABILITY_SRC" "$CAPABILITY_DST_DIR/evolution.md"

# ----------------------------------------------------------------------------
# 3. Merge hook mappings + token into openclaw.json
# ----------------------------------------------------------------------------
# OpenClaw reads hooks config from openclaw.json (NOT a separate
# settings.json — earlier MOSS docs misnamed this file). Two requirements:
#   - hooks.token must be set; gateway throws "hooks.enabled requires
#     hooks.token" otherwise → /hooks/* routes never register → POSTs
#     return 405 from the static-file fallback.
#   - hooks.token must NOT equal the gateway auth token; gateway throws
#     "hooks.token must not match gateway auth token" otherwise.
OPENCLAW_JSON="$MOSS_DATA_DIR/openclaw.json"
HOOKS_TOKEN="${MOSS_HOOKS_TOKEN:-}"
[ -n "$HOOKS_TOKEN" ] || {
  echo "[3/5] FAIL: MOSS_HOOKS_TOKEN not set — run setup.sh which auto-generates it." >&2
  exit 1
}
if [ -n "${MOSS_GATEWAY_TOKEN:-}" ] && [ "$HOOKS_TOKEN" = "$MOSS_GATEWAY_TOKEN" ]; then
  echo "[3/5] FAIL: MOSS_HOOKS_TOKEN equals MOSS_GATEWAY_TOKEN — gateway will refuse to start." >&2
  exit 1
fi
[ -f "$OPENCLAW_JSON" ] || {
  echo "[3/5] FAIL: $OPENCLAW_JSON missing — run setup.sh first." >&2
  exit 1
}

echo "[3/5] Merging hook mappings + token into $OPENCLAW_JSON"
# Idempotent: drop existing moss-* mappings before re-adding.
jq --slurpfile mappings "$HOOK_MAPPINGS_SRC" --arg token "$HOOKS_TOKEN" '
  .hooks //= {} |
  .hooks.enabled = ($mappings[0].hooks.enabled // true) |
  .hooks.token = $token |
  .hooks.mappings = (
    ((.hooks.mappings // []) | map(select(.id // "" | startswith("moss-") | not)))
    + $mappings[0].hooks.mappings
  )
' "$OPENCLAW_JSON" > "$OPENCLAW_JSON.tmp" && mv "$OPENCLAW_JSON.tmp" "$OPENCLAW_JSON"

# ----------------------------------------------------------------------------
# 4. Configure tools.exec.host=gateway in openclaw.json
# ----------------------------------------------------------------------------
# The agent needs to run shell commands (moss evo ...) via the gateway exec
# host. Default is 'sandbox', which requires a sandbox runtime. Set 'gateway'
# so the agent can run commands directly inside the container.
OPENCLAW_JSON="$MOSS_DATA_DIR/openclaw.json"
if [ -f "$OPENCLAW_JSON" ]; then
  echo "[4/5] Setting tools.exec.host=gateway and security=full in $OPENCLAW_JSON"
  jq '.tools //= {} | .tools.exec //= {} | .tools.exec.host = "gateway" | .tools.exec.security = "full"' \
    "$OPENCLAW_JSON" > "$OPENCLAW_JSON.tmp" && mv "$OPENCLAW_JSON.tmp" "$OPENCLAW_JSON"
else
  echo "[4/5] SKIP: $OPENCLAW_JSON not found — configure tools.exec.host=gateway manually."
fi

# ----------------------------------------------------------------------------
# 5. Register periodic auto-scan cron job
# ----------------------------------------------------------------------------
# openclaw binary isn't in container PATH; use node /app/openclaw.mjs instead.
# Flag syntax: `--every <duration>` + `--system-event <text>` + `--session main`
# + `--wake next-heartbeat`. The cron job's id is auto-generated; we identify
# the job by `--name moss-auto-scan-catchup` so re-running this script can
# detect and remove the previous one.
if docker ps --format '{{.Names}}' | grep -q '^moss-gateway$'; then
  echo "[5/5] Registering MOSS auto-scan cron job (every 30m)"
  # Idempotent: remove any existing job with this name first.
  EXISTING_ID="$(docker exec moss-gateway node /app/openclaw.mjs cron list --json 2>/dev/null \
    | jq -r '.jobs[]? | select(.name=="moss-auto-scan-catchup") | .id' | head -1)"
  if [ -n "$EXISTING_ID" ]; then
    docker exec moss-gateway node /app/openclaw.mjs cron rm "$EXISTING_ID" 2>/dev/null || true
  fi
  docker exec moss-gateway node /app/openclaw.mjs cron add \
    --name moss-auto-scan-catchup \
    --every 30m \
    --system-event "Run \`moss evo catch-up\` and tell me what happened." \
    --session main \
    --wake next-heartbeat \
    || echo "[5/5] WARNING: cron registration failed — check 'openclaw cron --help' against your version."
else
  echo "[5/5] SKIP: moss-gateway container not running — register cron job after starting it via:"
  echo "       docker exec moss-gateway node /app/openclaw.mjs cron add --name moss-auto-scan-catchup ..."
fi

echo ""
echo "MOSS evolution control surface installed."
echo ""
echo "Ensure your docker-compose.yml bind-mounts the CLI:"
echo "  volumes:"
echo "    - /path/to/MOSS/host-daemon/src/cli/moss:/usr/local/bin/moss:ro"
echo "and exposes:"
echo "  environment:"
echo "    OPENCLAW_GATEWAY_URL: http://localhost:18789"
echo "Then \`docker compose up -d\` to restart."

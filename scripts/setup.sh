#!/usr/bin/env bash
# MOSS setup script
# Reads .env, runs full pre-flight, builds openclaw, starts host-daemon, launches gateway.
set -euo pipefail

# ============================================================================
# Resolve repo root
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOSS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$MOSS_ROOT"

# ============================================================================
# Load .env if present
# ============================================================================
if [ -f ".env" ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
else
  echo "ERROR: .env not found at $MOSS_ROOT/.env. Copy .env.example and fill in keys." >&2
  exit 1
fi

# ============================================================================
# Derive paths
# ============================================================================
export MOSS_HOST_ROOT="${MOSS_HOST_ROOT:-$MOSS_ROOT}"
export MOSS_OPENCLAW_REPO_DIR="${MOSS_OPENCLAW_REPO_DIR:-$MOSS_HOST_ROOT/openclaw}"
export MOSS_DATA_DIR="${MOSS_DATA_DIR:-$HOME/.moss}"
export MOSS_DAEMON_SOCK="${MOSS_DAEMON_SOCK:-/tmp/moss.sock}"

# Host-side gateway URL for the daemon (supervisor + webhook fires).
# Container processes (webhook-fire.ts) use the in-container URL
# `http://localhost:18789` set via docker-compose env; that doesn't help
# the host daemon since the gateway is only reachable on host via the
# port-mapped 19799. Default to that; user can override if they remapped.
export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:19799}"

# ============================================================================
# Persist derived path values to .env so docker compose restart / host reboot
# without re-running setup.sh sees real values instead of the empty
# placeholders from .env.example. Without this, the gateway boots into
# degraded mode after any restart that bypasses setup.sh:
#   [gateway] evolution service started in degraded mode
#     (bootError=MOSS_OPENCLAW_REPO_DIR is not set)
# ============================================================================
persist_to_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    # Use | as sed delimiter to avoid collision with path separators.
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}
persist_to_env MOSS_HOST_ROOT          "$MOSS_HOST_ROOT"
persist_to_env MOSS_OPENCLAW_REPO_DIR  "$MOSS_OPENCLAW_REPO_DIR"

# ============================================================================
# Pre-flight checks (I1.b)
# ============================================================================
echo "[1/9] Pre-flight checks..."

# Docker without sudo
if ! docker ps >/dev/null 2>&1; then
  echo "FAIL: 'docker ps' fails without sudo." >&2
  echo "Fix: sudo usermod -aG docker $USER && newgrp docker" >&2
  exit 1
fi
echo "  ✓ docker accessible"

# pnpm + node
command -v pnpm >/dev/null || { echo "FAIL: pnpm not installed. https://pnpm.io/installation" >&2; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not installed. Node 22+ required." >&2; exit 1; }
echo "  ✓ pnpm + node present ($(node --version))"

# python3
command -v python3 >/dev/null || { echo "FAIL: python3 not installed. Python 3.11+ required." >&2; exit 1; }
PY_VERSION=$(python3 -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])')
[ "$PY_VERSION" -ge 311 ] || { echo "FAIL: Python 3.11+ required (have $PY_VERSION)." >&2; exit 1; }
echo "  ✓ python3 present"

# jq — needed by install-moss-control-surface.sh to merge settings.json + openclaw.json
command -v jq >/dev/null || { echo "FAIL: jq not installed (needed for settings/config merging). Install: 'apt install jq' / 'brew install jq'." >&2; exit 1; }
echo "  ✓ jq present"

# Coding-agent CLI for the selected provider. Failure mode if we soft-warn
# instead of hard-fail: setup.sh exits OK, the daemon starts, but every
# evolution role spawn fails inside the daemon log and the user has no
# clue where to look. Fail hard at preflight with an actionable hint.
PROVIDER="${MOSS_AGENT_PROVIDER:-claude}"
case "$PROVIDER" in
  claude)
    AGENT_BIN="${CLAUDE_BIN:-claude}"; BIN_VAR="CLAUDE_BIN"
    INSTALL_URL="https://claude.com/code" ;;
  codex)
    AGENT_BIN="${CODEX_BIN:-codex}"; BIN_VAR="CODEX_BIN"
    INSTALL_URL="https://github.com/openai/codex" ;;
  deepseek-tui)
    AGENT_BIN="${DEEPSEEK_TUI_BIN:-deepseek-tui}"; BIN_VAR="DEEPSEEK_TUI_BIN"
    INSTALL_URL="https://github.com/Hmbown/DeepSeek-TUI" ;;
  opencode)
    AGENT_BIN="${OPENCODE_BIN:-opencode}"; BIN_VAR="OPENCODE_BIN"
    INSTALL_URL="https://opencode.ai" ;;
  *)
    echo "FAIL: unknown MOSS_AGENT_PROVIDER='$PROVIDER'. Supported: claude, codex, deepseek-tui, opencode." >&2
    exit 1 ;;
esac
if ! command -v "$AGENT_BIN" >/dev/null 2>&1; then
  echo "FAIL: coding-agent CLI '$AGENT_BIN' not found." >&2
  echo "      MOSS_AGENT_PROVIDER='$PROVIDER' needs it. Install: $INSTALL_URL" >&2
  echo "      Or set $BIN_VAR in .env to an absolute path." >&2
  exit 1
fi
echo "  ✓ coding-agent CLI present ($PROVIDER → $AGENT_BIN)"

# MOSS_DATA_DIR writable
mkdir -p "$MOSS_DATA_DIR"
[ -w "$MOSS_DATA_DIR" ] || { echo "FAIL: $MOSS_DATA_DIR not writable." >&2; exit 1; }
echo "  ✓ $MOSS_DATA_DIR writable"

# Inner repo + working tree
if [ ! -d "$MOSS_OPENCLAW_REPO_DIR/.git" ]; then
  echo "  ⓘ openclaw/ has no .git — initializing local repo for evolution baseline..."
  git -C "$MOSS_OPENCLAW_REPO_DIR" init -q
  git -C "$MOSS_OPENCLAW_REPO_DIR" add -A
  git -C "$MOSS_OPENCLAW_REPO_DIR" -c user.name="MOSS Evolution" -c user.email="evolution@moss.local" \
       commit -q -m "baseline at moss install $(date +%Y-%m-%d)"
fi

# G-1: set LOCAL git identity for evolution commits in moss/openclaw/ only.
# Does NOT touch user's global ~/.gitconfig. Idempotent: skip if already set.
if [ "$(git -C "$MOSS_OPENCLAW_REPO_DIR" config --local --default='' user.email)" != "evolution@moss.local" ]; then
  git -C "$MOSS_OPENCLAW_REPO_DIR" config user.name  "MOSS Evolution"
  git -C "$MOSS_OPENCLAW_REPO_DIR" config user.email "evolution@moss.local"
  echo "  ✓ inner-repo git identity set to MOSS Evolution <evolution@moss.local>"
else
  echo "  ✓ inner-repo git identity already set"
fi

# G-2: working tree clean. Outer git pull updates files inside openclaw/
# that the inner repo also tracks → inner shows them as dirty (this is by
# design — outer is the source of truth for source code, inner is the
# evolution baseline). Auto-recover by committing the outer-pulled state
# as a new baseline. Safe because inner commits are local-only and used
# solely for evolution branch tracking; outer history is untouched.
# Skip auto-recovery if inner is on a non-default branch (likely an
# in-flight evo-* branch we shouldn't disturb).
if [ -n "$(git -C "$MOSS_OPENCLAW_REPO_DIR" status --porcelain)" ]; then
  inner_branch="$(git -C "$MOSS_OPENCLAW_REPO_DIR" rev-parse --abbrev-ref HEAD)"
  if [ "$inner_branch" = "master" ] || [ "$inner_branch" = "main" ]; then
    echo "  ⓘ inner-repo dirty (likely from outer pull); committing as new baseline"
    git -C "$MOSS_OPENCLAW_REPO_DIR" add -A
    git -C "$MOSS_OPENCLAW_REPO_DIR" commit -q -m "baseline at moss setup $(date +%Y-%m-%d)"
    # Inner HEAD moved → MOSS_H_PRE in .env is stale. Clear it so the
    # block below re-derives from the new HEAD.
    unset MOSS_H_PRE
    sed -i '/^MOSS_H_PRE=/d' .env
  else
    echo "FAIL: $MOSS_OPENCLAW_REPO_DIR is dirty on branch '$inner_branch'." >&2
    echo "      Auto-recovery only runs on master/main. Commit/discard manually," >&2
    echo "      or switch to the default branch and re-run." >&2
    exit 1
  fi
fi
echo "  ✓ inner-repo working tree clean"

# G-3: no evo-* branch collision
if [ -n "$(git -C "$MOSS_OPENCLAW_REPO_DIR" branch --list 'evo-*')" ]; then
  echo "WARN: pre-existing 'evo-*' branches found. They may collide with evolution. List:" >&2
  git -C "$MOSS_OPENCLAW_REPO_DIR" branch --list 'evo-*' >&2
  echo "      To clean up: git -C $MOSS_OPENCLAW_REPO_DIR branch -D <name>" >&2
fi

# Baseline commit (auto-captured on first run; persisted to .env so that
# subsequent `docker compose up`s from a fresh shell don't lose it). Without
# persistence, the gateway falls back to evolution preflight mode-3
# (get-baseline-commit RPC to the host daemon) — correct but one extra
# round-trip per gateway boot. Edit / delete the line in .env to rebaseline.
if [ -z "${MOSS_H_PRE:-}" ]; then
  MOSS_H_PRE=$(git -C "$MOSS_OPENCLAW_REPO_DIR" rev-parse HEAD)
  persist_to_env MOSS_H_PRE "$MOSS_H_PRE"
  export MOSS_H_PRE
  echo "  ✓ baseline commit (MOSS_H_PRE) = ${MOSS_H_PRE:0:10} (persisted to .env)"
else
  export MOSS_H_PRE
  echo "  ✓ baseline commit (MOSS_H_PRE) = ${MOSS_H_PRE:0:10} (from .env)"
fi

# Socket not bound. Defensive: docker compose creates an empty DIRECTORY at
# the bind-mount path if the socket file doesn't exist when 'compose up' runs,
# which then prevents the daemon from binding the socket on next boot. Clean
# both stale-socket and stale-dir cases here before re-binding.
if [ -d "$MOSS_DAEMON_SOCK" ] && [ ! -L "$MOSS_DAEMON_SOCK" ]; then
  echo "  ⓘ $MOSS_DAEMON_SOCK exists as directory (docker mount-point leak); removing..."
  if ! rmdir "$MOSS_DAEMON_SOCK" 2>/dev/null; then
    sudo rmdir "$MOSS_DAEMON_SOCK" 2>/dev/null \
      || { echo "FAIL: cannot remove directory $MOSS_DAEMON_SOCK; check permissions" >&2; exit 1; }
  fi
fi
if [ -S "$MOSS_DAEMON_SOCK" ]; then
  if lsof "$MOSS_DAEMON_SOCK" >/dev/null 2>&1; then
    echo "FAIL: $MOSS_DAEMON_SOCK is bound by another process. Stop the daemon first:" >&2
    echo "  cat $MOSS_DATA_DIR/daemon.pid 2>/dev/null && kill \$(cat $MOSS_DATA_DIR/daemon.pid)" >&2
    exit 1
  fi
  rm -f "$MOSS_DAEMON_SOCK"
fi

# .env credentials sanity
[ -n "${MOSS_MODEL_API_KEY:-}" ] \
  || { echo "FAIL: MOSS_MODEL_API_KEY not set in .env" >&2; exit 1; }
[ -n "${MOSS_MODEL_BASE_URL:-}" ] \
  || { echo "FAIL: MOSS_MODEL_BASE_URL not set in .env" >&2; exit 1; }
[ -n "${MOSS_MODEL_ID:-}" ] \
  || { echo "FAIL: MOSS_MODEL_ID not set in .env" >&2; exit 1; }

# Gateway token (auto-generated on first run; persisted to .env)
if [ -z "${MOSS_GATEWAY_TOKEN:-}" ]; then
  MOSS_GATEWAY_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  persist_to_env MOSS_GATEWAY_TOKEN "$MOSS_GATEWAY_TOKEN"
  export MOSS_GATEWAY_TOKEN
  echo "  ✓ generated MOSS_GATEWAY_TOKEN (persisted to .env)"
else
  echo "  ✓ MOSS_GATEWAY_TOKEN from .env"
fi

# Hooks token — must be DISTINCT from MOSS_GATEWAY_TOKEN. The gateway
# enforces this at config-load time ("hooks.token must not match gateway
# auth token"); reusing the same value causes the gateway to refuse to
# start. Auto-generate on first run; both webhook sender (TS loop.ts +
# Python supervisor.py) and receiver (gateway) prefer MOSS_HOOKS_TOKEN.
if [ -z "${MOSS_HOOKS_TOKEN:-}" ]; then
  MOSS_HOOKS_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  persist_to_env MOSS_HOOKS_TOKEN "$MOSS_HOOKS_TOKEN"
  export MOSS_HOOKS_TOKEN
  echo "  ✓ generated MOSS_HOOKS_TOKEN (persisted to .env)"
else
  if [ "$MOSS_HOOKS_TOKEN" = "${MOSS_GATEWAY_TOKEN:-}" ]; then
    echo "FAIL: MOSS_HOOKS_TOKEN equals MOSS_GATEWAY_TOKEN — gateway will refuse to start." >&2
    echo "      Set MOSS_HOOKS_TOKEN to a distinct value in .env, or delete it to auto-generate." >&2
    exit 1
  fi
  echo "  ✓ MOSS_HOOKS_TOKEN from .env"
fi

# ============================================================================
# Build openclaw (one-time + on-change). Idempotent: skip if dist/ already
# fresh — rerun with MOSS_FORCE_REBUILD=1 if you've pulled new openclaw code.
# ============================================================================
cd "$MOSS_OPENCLAW_REPO_DIR"

# Stale-dist detection. The bare existence-of-dist/index.js check is too
# loose: after `git pull` brings in src/ changes, the file is still present
# but its contents lag behind src/. Find any src/ file newer than the
# build artifact — if one exists, force a rebuild.
src_newer=""
if [ -f "dist/index.js" ]; then
  src_newer="$(find src -type f -newer dist/index.js -print -quit 2>/dev/null)"
fi

if [ "${MOSS_FORCE_REBUILD:-0}" = "1" ] || [ ! -f "dist/index.js" ] || [ ! -d "dist/control-ui" ] || [ ! -d "node_modules" ] || [ -n "$src_newer" ]; then
  if [ -n "$src_newer" ] && [ "${MOSS_FORCE_REBUILD:-0}" != "1" ]; then
    echo "  ⓘ src/ newer than dist/ (e.g. $src_newer); triggering rebuild"
  fi
  echo "[2/9] Installing openclaw dependencies..."
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  echo "[3/9] Building openclaw (backend + control UI, single command)..."
  pnpm build
  echo "  ✓ openclaw built (dist/ + dist/control-ui/)"
else
  echo "[2/9] openclaw dependencies present (node_modules/ exists; skip install)"
  echo "[3/9] openclaw dist/ + dist/control-ui/ already built; skip rebuild (set MOSS_FORCE_REBUILD=1 to force)"
fi

# ============================================================================
# Write openclaw.json + auth-profiles.json from .env values. Idempotent:
# only write if missing — rerun with MOSS_FORCE_RECONFIG=1 to overwrite.
# (Skip protects manually-edited openclaw.json from being overwritten on
# subsequent setup.sh runs.)
# ============================================================================
mkdir -p "$MOSS_DATA_DIR/agents/main/agent"
if [ "${MOSS_FORCE_RECONFIG:-0}" = "1" ] || [ ! -f "$MOSS_DATA_DIR/openclaw.json" ]; then
  echo "[4/9] Writing $MOSS_DATA_DIR/openclaw.json + auth-profiles.json from .env..."
  cat > "$MOSS_DATA_DIR/openclaw.json" <<EOF
{
  "meta": { "lastTouchedVersion": "moss-0.1.0", "lastTouchedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" },
  "commands": { "native": "auto", "nativeSkills": "auto", "restart": true, "ownerDisplay": "raw" },
  "gateway": { "mode": "local", "port": 18789, "controlUi": { "dangerouslyDisableDeviceAuth": true } },
  "models": {
    "mode": "merge",
    "providers": {
      "chat": {
        "baseUrl": "$MOSS_MODEL_BASE_URL",
        "apiKey": "\${MOSS_MODEL_API_KEY}",
        "api": "openai-completions",
        "models": [{ "id": "${MOSS_MODEL_ID}", "name": "${MOSS_MODEL_ID}", "contextWindow": 131072, "maxTokens": 8192 }]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "chat/${MOSS_MODEL_ID}" },
      "workspace": "/home/node/.openclaw/workspace",
      "compaction": { "mode": "safeguard" },
      "maxConcurrent": 4,
      "subagents": { "maxConcurrent": 8 }
    },
    "list": [{ "id": "main" }]
  },
  "auth": {
    "profiles": {
      "chat:default": { "provider": "chat", "mode": "api_key" }
    }
  }
}
EOF

  cat > "$MOSS_DATA_DIR/agents/main/agent/auth-profiles.json" <<EOF
{
  "version": 1,
  "profiles": {
    "chat:default": {
      "type": "api_key",
      "provider": "chat",
      "key": "$MOSS_MODEL_API_KEY"
    }
  },
  "lastGood": { "chat": "chat:default" }
}
EOF
  chmod 600 "$MOSS_DATA_DIR/agents/main/agent/auth-profiles.json"
  echo "  ✓ openclaw.json + auth-profiles.json written"
else
  echo "[4/9] $MOSS_DATA_DIR/openclaw.json already exists; skip (set MOSS_FORCE_RECONFIG=1 to overwrite)"
fi

# ============================================================================
# Start host-daemon (I2.a: nohup + pidfile)
# ============================================================================
echo "[5/9] Starting host-daemon..."
cd "$MOSS_HOST_ROOT/host-daemon"
PIDFILE="$MOSS_DATA_DIR/daemon.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "WARN: host-daemon already running (pid=$(cat "$PIDFILE")). Stopping it first..." >&2
  kill "$(cat "$PIDFILE")" || true
  sleep 2
fi

nohup python3 -m src.main >> "$MOSS_DATA_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PIDFILE"
echo "  ✓ host-daemon pid=$DAEMON_PID; log=$MOSS_DATA_DIR/daemon.log"

# Wait for socket (30s budget; first-time imports / venv resolution can be slow)
echo "[6/9] Waiting for daemon socket..."
for _ in $(seq 1 30); do
  [ -S "$MOSS_DAEMON_SOCK" ] && break
  sleep 1
done
[ -S "$MOSS_DAEMON_SOCK" ] || { echo "FAIL: host-daemon did not bind $MOSS_DAEMON_SOCK in 30s. Check $MOSS_DATA_DIR/daemon.log" >&2; exit 1; }
echo "  ✓ daemon bound $MOSS_DAEMON_SOCK"

# ============================================================================
# docker compose up moss-gateway (auto-builds image on first run)
# ============================================================================
cd "$MOSS_HOST_ROOT"

# Export the vars docker-compose needs (inlined into the container env)
export MOSS_DATA_DIR MOSS_DAEMON_SOCK MOSS_HOST_ROOT MOSS_MODEL_API_KEY MOSS_MODEL_BASE_URL MOSS_MODEL_ID MOSS_H_PRE MOSS_GATEWAY_TOKEN MOSS_HOOKS_TOKEN

IMAGE_TAG="${MOSS_IMAGE:-moss:baseline}"
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "[7/9] $IMAGE_TAG not built yet — building (~5 min first time)..."
  docker compose build moss-gateway
  echo "  ✓ $IMAGE_TAG built"
else
  echo "[7/9] $IMAGE_TAG already built; skip (force fresh build with \`docker compose build --no-cache moss-gateway\`)"
fi
# --force-recreate is required: step [5/9] always kills+respawns the host
# daemon, which creates a fresh socket file at $MOSS_DAEMON_SOCK with a
# new inode. Docker bind-mounts capture the inode at mount-time, so a
# previously-running container holds a stale inode pointing nowhere →
# `moss evo flag` and other socket-based commands return "Connection
# refused" even though the socket file appears present in the container.
# Recreating guarantees the bind-mount picks up the new inode.
docker compose up -d --force-recreate moss-gateway

# Health probe
echo "[8/9] Waiting for gateway to be ready..."
for _ in $(seq 1 15); do
  if curl -fs -o /dev/null "http://localhost:19799/api/health" 2>/dev/null; then
    echo "  ✓ gateway responding at http://localhost:19799"
    break
  fi
  sleep 2
done

# ============================================================================
# Install MOSS evolution control surface (CLI symlink + evolution.md +
# hook mappings + tools.exec.host config + periodic auto-scan cron). Without
# this step the agent can read `moss evo *` commands but the agent can't run
# them (sandbox exec error), webhooks don't deliver, and periodic auto-scan
# never fires. Idempotent — safe to re-run.
# ============================================================================
echo "[9/9] Installing MOSS evolution control surface..."
export MOSS_REPO_ROOT="$MOSS_ROOT"
if bash "$MOSS_HOST_ROOT/host-daemon/scripts/install-moss-control-surface.sh"; then
  echo "  ✓ control surface installed"
else
  echo "  WARN: install-moss-control-surface.sh failed. The base stack is up but"
  echo "        conversation-driven control (Path B in README) is partially configured."
  echo "        See: $MOSS_HOST_ROOT/host-daemon/scripts/install-moss-control-surface.sh" >&2
fi

# ============================================================================
# Done
# ============================================================================
echo
echo "============================================================================"
echo "MOSS is up."
echo "  Dashboard: http://localhost:19799/?token=$MOSS_GATEWAY_TOKEN"
echo "  Data dir:  $MOSS_DATA_DIR"
echo "  Daemon log: $MOSS_DATA_DIR/daemon.log"
echo "  Daemon pid: $(cat "$PIDFILE")"
echo "  Stop: kill \$(cat $PIDFILE) && docker compose down moss-gateway"
echo "============================================================================"

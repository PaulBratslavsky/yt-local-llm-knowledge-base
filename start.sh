#!/usr/bin/env bash
# Start the full stack: Ollama (with tuned env vars) + Strapi + TanStack client.
#
# Usage:
#   ./start.sh                   # start everything, reuse running Ollama
#   ./start.sh --restart-ollama  # force-restart Ollama so env vars take effect
#
# Env overrides (export before running, or put in your shell profile):
#   OLLAMA_KEEP_ALIVE   — how long models stay warm (default: 15m)
#   OLLAMA_NUM_PARALLEL — concurrent Ollama slots (default: 1; bump if RAM allows)
#
# Tested on macOS with the Ollama menubar app. Other platforms need to
# swap the `open -a Ollama` path.

set -e

# --- defaults (can be overridden via environment) ---------------------------
: "${OLLAMA_KEEP_ALIVE:=15m}"
: "${OLLAMA_NUM_PARALLEL:=1}"
FORCE_RESTART_OLLAMA=0

for arg in "$@"; do
  case $arg in
    --restart-ollama|-r) FORCE_RESTART_OLLAMA=1 ;;
    -h|--help)
      grep '^#' "$0" | head -20
      exit 0
      ;;
  esac
done

# --- check prerequisites ----------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  echo "✗ ollama CLI not found. Install from https://ollama.com/download"
  exit 1
fi

if ! command -v yarn >/dev/null 2>&1; then
  echo "✗ yarn not found. Install with: npm install -g yarn"
  exit 1
fi

# --- set launchctl env so future Ollama launches inherit them ---------------
# (Existing running Ollama won't pick these up — use --restart-ollama for that)
echo "→ launchctl setenv OLLAMA_KEEP_ALIVE=$OLLAMA_KEEP_ALIVE OLLAMA_NUM_PARALLEL=$OLLAMA_NUM_PARALLEL"
launchctl setenv OLLAMA_KEEP_ALIVE "$OLLAMA_KEEP_ALIVE"
launchctl setenv OLLAMA_NUM_PARALLEL "$OLLAMA_NUM_PARALLEL"

# --- optionally restart Ollama so the new env applies ----------------------
if [ $FORCE_RESTART_OLLAMA -eq 1 ]; then
  echo "→ Restarting Ollama (pkill -9)..."
  pkill -9 ollama 2>/dev/null || true
  sleep 1
fi

# --- ensure Ollama server is up --------------------------------------------
if curl -sf -o /dev/null http://localhost:11434/api/version; then
  CURRENT_KEEP_ALIVE=$(launchctl getenv OLLAMA_KEEP_ALIVE)
  CURRENT_PARALLEL=$(launchctl getenv OLLAMA_NUM_PARALLEL)
  echo "✓ Ollama already running (new env takes effect on next restart;"
  echo "   current session has KEEP_ALIVE=$CURRENT_KEEP_ALIVE, NUM_PARALLEL=$CURRENT_PARALLEL)"
else
  echo "→ Starting Ollama..."
  if [ -d "/Applications/Ollama.app" ]; then
    open -a Ollama
  else
    nohup ollama serve > /tmp/ollama.log 2>&1 &
  fi
  # Wait up to 15s for the server to come up
  for i in {1..15}; do
    if curl -sf -o /dev/null http://localhost:11434/api/version; then
      echo "✓ Ollama ready"
      break
    fi
    if [ "$i" -eq 15 ]; then
      echo "✗ Ollama didn't start within 15s — check /tmp/ollama.log or the menubar app"
      exit 1
    fi
    sleep 1
  done
fi

# --- start Strapi + client (delegates to existing yarn dev) ----------------
echo "→ Starting Strapi (1337) + TanStack client (3000) via yarn dev..."
echo ""
exec yarn dev

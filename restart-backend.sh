#!/usr/bin/env bash
# Kill anything on the backend port and start a fresh uvicorn (with --reload)
# from backend/.venv. Logs to /tmp/spectraleye-backend.log; PID printed at the
# end so you can `kill <pid>` later if needed.
#
# Usage:
#   ./restart-backend.sh            # background (default)
#   ./restart-backend.sh --fg       # foreground (Ctrl-C to stop)

set -euo pipefail

PORT="${SPECTRALEYE_BACKEND_PORT:-8000}"
HOST="${SPECTRALEYE_BACKEND_HOST:-127.0.0.1}"
LOG="/tmp/spectraleye-backend.log"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Find a usable uvicorn. Prefer the venv next to this script, then any
# worktree's venv (development often happens in a worktree), then anything
# on PATH. uvicorn's --app-dir lets us point at backend/ regardless of which
# repo checkout's venv we ended up using.
candidates=("$ROOT/backend/.venv/bin/uvicorn")
for vw in "$ROOT"/.claude/worktrees/*/backend/.venv/bin/uvicorn; do
  [[ -x "$vw" ]] && candidates+=("$vw")
done
if command -v uvicorn >/dev/null 2>&1; then
  candidates+=("$(command -v uvicorn)")
fi

VENV_UVICORN=""
for c in "${candidates[@]}"; do
  if [[ -x "$c" ]]; then
    VENV_UVICORN="$c"
    break
  fi
done

if [[ -z "$VENV_UVICORN" ]]; then
  echo "error: no uvicorn found. Looked in:" >&2
  for c in "${candidates[@]}"; do echo "       $c" >&2; done
  echo "       create a venv: (cd backend && python3.14 -m venv .venv && .venv/bin/pip install -e .)" >&2
  exit 1
fi

if [[ "$VENV_UVICORN" != "$ROOT/backend/.venv/bin/uvicorn" ]]; then
  echo "note: using uvicorn from $VENV_UVICORN (no local venv at $ROOT/backend/.venv)"
fi

# Kill any process holding the port. lsof returns non-zero when nothing matches,
# so swallow that — we only care if pids exist.
PIDS="$(lsof -nP -ti:"$PORT" 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "killing pids on :$PORT → $PIDS"
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  # Give the kernel a beat to release the listener so the new uvicorn binds cleanly.
  sleep 0.5
  PIDS_LEFT="$(lsof -nP -ti:"$PORT" 2>/dev/null || true)"
  if [[ -n "$PIDS_LEFT" ]]; then
    echo "force-killing leftover pids → $PIDS_LEFT"
    # shellcheck disable=SC2086
    kill -9 $PIDS_LEFT 2>/dev/null || true
    sleep 0.3
  fi
fi

cd "$ROOT/backend"

if [[ "${1:-}" == "--fg" ]]; then
  echo "starting uvicorn on $HOST:$PORT (foreground)"
  exec "$VENV_UVICORN" app.main:app --host "$HOST" --port "$PORT" --reload
fi

# Background. nohup + setsid-ish via disown so the process survives this shell.
echo "starting uvicorn on $HOST:$PORT (background, log: $LOG)"
nohup "$VENV_UVICORN" app.main:app --host "$HOST" --port "$PORT" --reload \
  > "$LOG" 2>&1 &
PID=$!
disown $PID 2>/dev/null || true

# Wait briefly for the listener to come up so we can confirm success.
for _ in {1..30}; do
  if lsof -nP -ti:"$PORT" >/dev/null 2>&1; then
    echo "backend up: pid $PID, listening on $HOST:$PORT"
    exit 0
  fi
  sleep 0.2
done

echo "warn: backend pid $PID started but didn't bind :$PORT within 6s — check $LOG" >&2
exit 2

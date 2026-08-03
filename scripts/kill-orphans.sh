#!/bin/bash
# Kill orphan agent processes left from prior Synapse runs.
# Used by systemd ExecStartPre and restart.sh.
# Uses pgrep+kill to avoid pkill self-matching problem.

SELF=$$

for pattern in "test-api-server" "mcp-server.js" "opencode"; do
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  for pid in $pids; do
    [ "$pid" = "$SELF" ] && continue
    # Don't kill our parent either
    [ "$pid" = "$PPID" ] && continue
    kill "$pid" 2>/dev/null && echo "Killed orphan: pid=$pid pattern=$pattern" || true
  done
done

# Also free port 8080 if anything is holding it
PORT_PID=$(lsof -ti:8080 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
  echo "Freeing port 8080 (PID: $PORT_PID)"
  kill "$PORT_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$PORT_PID" 2>/dev/null || true
fi

exit 0

#!/usr/bin/env bash
set -euo pipefail

SYNAPSE_DIR="${1:-/path/to/synapse}"
LOG_FILE="/var/log/synapse-git-maintenance.log"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

log() {
  echo "[$TIMESTAMP] $*" | tee -a "$LOG_FILE"
}

cd "$SYNAPSE_DIR" || { log "ERROR: Cannot cd to $SYNAPSE_DIR"; exit 1; }

log "=== Daily Git Maintenance Start ==="

log "Stashing uncommitted changes..."
git stash --include-untracked --quiet 2>/dev/null || true

log "Pulling latest from main remote..."
git pull origin main --quiet 2>/dev/null || log "WARN: git pull failed (may be offline)"

log "Popping stash..."
git stash pop --quiet 2>/dev/null || true

log "Auto-committing unstaged changes..."
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git diff --cached --quiet || git commit -m "maintenance: daily auto-commit $(date -u +%Y-%m-%d)" --quiet
  log "Committed pending changes"
else
  log "No pending changes"
fi

log "Running git fsck..."
git fsck --no-dangling 2>&1 | tee -a "$LOG_FILE" || log "WARN: git fsck reported issues"

log "Running git gc..."
git gc --auto --quiet 2>&1 | tee -a "$LOG_FILE" || log "WARN: git gc reported issues"

log "=== Daily Git Maintenance Complete ==="

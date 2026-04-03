#!/usr/bin/env bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
REMOTE_URL="https://github.com/Teddmab/kazione-booking-backend.git"
BRANCH="main"
COMMIT_MSG="${1:-feat: initial commit — KaziOne Booking backend}"

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}▸ Initialising git repo…${NC}"
git init

echo -e "${YELLOW}▸ Adding remote origin…${NC}"
git remote add origin "$REMOTE_URL" 2>/dev/null || git remote set-url origin "$REMOTE_URL"

echo -e "${YELLOW}▸ Staging all files…${NC}"
git add -A

echo -e "${YELLOW}▸ Committing…${NC}"
git commit -m "$COMMIT_MSG"

echo -e "${YELLOW}▸ Pushing to ${REMOTE_URL} (branch: ${BRANCH})…${NC}"
git branch -M "$BRANCH"
git push -u origin "$BRANCH"

echo -e "${GREEN}✔ Done! Pushed to ${REMOTE_URL}${NC}"

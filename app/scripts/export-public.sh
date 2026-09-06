#!/usr/bin/env bash
# Build a clean, shareable copy of the app in a new directory with NO git
# history and no personal values. Usage: scripts/export-public.sh <dest-dir>
# Then: cd <dest-dir> && git init && git add -A && git commit -m "shmoney"
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?dest dir required}"
mkdir -p "$DEST"

rsync -a --delete \
  --exclude node_modules --exclude .wrangler --exclude .dev.vars --exclude cookies.txt \
  --exclude BACKFILL-NOTES.md --exclude CONTRACT.md --exclude design \
  "$SRC/" "$DEST/"

# Placeholders for anything tied to one account.
sed -i.bak -E 's/"database_id": "[^"]+"/"database_id": "REPLACE_ME"/' "$DEST/wrangler.jsonc" && rm -f "$DEST/wrangler.jsonc.bak"

# Fail loudly if a personal string slipped through.
if grep -rIn --exclude-dir=node_modules -iE 'josephlove|29be106f|jlove' "$DEST" ; then
  echo "personal strings found above; fix before publishing" >&2; exit 1
fi
echo "clean copy written to $DEST"

#!/usr/bin/env bash
# First-time setup for your own copy of shmoney. Run from the app directory
# after `npm install` and `npx wrangler login`. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="shmoney"

echo "== D1 database"
if npx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  echo "   $DB_NAME already exists"
else
  npx wrangler d1 create "$DB_NAME" >/dev/null
  echo "   created $DB_NAME"
fi
DB_ID="$(npx wrangler d1 info "$DB_NAME" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).uuid))')"
if grep -q '"database_id": "REPLACE_ME"' wrangler.jsonc; then
  sed -i.bak "s/\"database_id\": \"REPLACE_ME\"/\"database_id\": \"$DB_ID\"/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "   wrote database_id into wrangler.jsonc"
fi

echo "== Migrations"
npx wrangler d1 migrations apply "$DB_NAME" --remote

echo "== Secrets (leave blank to keep an existing value)"
ask_secret() {
  local name="$1" hint="$2" value
  read -r -s -p "   $name ($hint): " value; echo
  if [ -n "$value" ]; then printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null && echo "   set $name"; fi
}
ask_secret APP_PASSWORD "login password"
ask_secret SESSION_SECRET "any long random string; press enter to generate"
if ! npx wrangler secret list 2>/dev/null | grep -q SESSION_SECRET; then
  node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' | npx wrangler secret put SESSION_SECRET >/dev/null
  echo "   generated SESSION_SECRET"
fi
ask_secret PLAID_CLIENT_ID "Plaid dashboard -> Developers -> Keys"
ask_secret PLAID_SECRET "Plaid production secret"

echo "== Deploy"
npx wrangler deploy

cat <<EOF

Done. Next:
  1. In Plaid (Developers -> API -> Allowed redirect URIs) add:
       https://<your worker url above>/link/oauth
  2. Open the app, sign in, Settings -> Link account.
EOF

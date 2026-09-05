#!/usr/bin/env bash
# Smoke test: log in and hit every read endpoint; prints non-200s. Usage:
#   scripts/smoke.sh [base_url] [password]     (defaults: http://localhost:8787, shmoney-dev)
BASE="${1:-http://localhost:8787}"; PW="${2:-shmoney-dev}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d "{\"password\":\"$PW\"}" >/dev/null
M="$(date +%Y-%m)"
fail=0
for path in /api/auth/check /api/overview /api/accounts /api/items /api/items/links "/api/transactions?limit=5" \
  "/api/transactions?q=5.00&limit=3" "/api/transactions?flagged=1" /api/categories /api/rules "/api/budgets?month=$M" \
  "/api/budgets/$M/suggestions" "/api/cashflow?month=$M" "/api/cashflow?range=ytd" "/api/cashflow?range=1y" \
  "/api/stats?month=$M" "/api/stats?month=$M&range=1y" /api/investments /api/market/performance /api/market/sectors /api/market/pulse \
  /api/recurring /api/recurring/candidates /api/settings /api/taxes "/api/export/csv?table=transactions&limit=1" \
  "/api/logo?domain=target.com" /api/version; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE$path")"
  if [ "$code" != "200" ]; then echo "FAIL $code $path"; fail=1; else echo "ok   $path"; fi
done
exit $fail

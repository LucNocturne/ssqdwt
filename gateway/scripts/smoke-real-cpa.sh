#!/usr/bin/env bash
# Local gateway → real CPA end-to-end smoke test.
# Run: ADMIN=<...> KEY_HASH_SECRET=<...> bash scripts/smoke-real-cpa.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ADMIN:=$(openssl rand -hex 16)}"
: "${KEY_HASH_SECRET:=$(openssl rand -hex 32)}"
: "${PORT:=8787}"
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${UPSTREAM_TIMEOUT_MS:=15000}"

rm -f data/gateway.db data/gateway.db-shm data/gateway.db-wal

echo "[*] starting gateway (cpa upstream, 15s timeout)..."
KEY_HASH_SECRET="$KEY_HASH_SECRET" \
ADMIN_TOKEN="$ADMIN" \
PORT="$PORT" \
UPSTREAM_MODE=cpa \
CPA_BASE_URL="$CPA_BASE_URL" \
CPA_API_KEY="$CPA_API_KEY" \
UPSTREAM_TIMEOUT_MS="$UPSTREAM_TIMEOUT_MS" \
bun src/index.ts > /tmp/gw.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

# wait for ready
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then break; fi
  sleep 0.2
done

echo
echo "=== /health ==="
curl -s "http://127.0.0.1:$PORT/health"; echo

echo
echo "=== create key ==="
KJ=$(curl -s -X POST "http://127.0.0.1:$PORT/admin/keys" \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d '{"label":"local-cpa-smoke","initial_credits":200}')
echo "$KJ"
SK=$(printf '%s' "$KJ" | grep -oE 'sk-img-[A-Za-z0-9_-]+' || true)
if [[ -z "$SK" ]]; then echo "FAIL: no key"; exit 1; fi

echo
echo "=== /v1/models ==="
curl -s "http://127.0.0.1:$PORT/v1/models" -H "Authorization: Bearer $SK" | head -c 400; echo

echo
echo "=== generate (img-hd, cost=3, expect 504 timeout — CPA has 0 clients) ==="
T0=$(date +%s)
RESP=$(curl -s -m 30 -o /tmp/gen.json -w "%{http_code}|%{time_total}" \
  -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -d '{"model":"img-hd","prompt":"a cyberpunk cat"}')
T1=$(date +%s)
echo "  status|time_total: $RESP"
echo "  body: $(cat /tmp/gen.json | head -c 300)"
echo "  wall_elapsed: $((T1-T0))s"

echo
echo "=== balance (expect 200 — full refund after upstream timeout) ==="
BAL=$(curl -s "http://127.0.0.1:$PORT/v1/usage" -H "Authorization: Bearer $SK")
echo "$BAL" | head -c 400; echo

echo
echo "=== gateway log tail ==="
tail -10 /tmp/gw.log

#!/usr/bin/env bash
# Capacity test phase 2 (sustained) + phase 3 (4K integrity).
# Phase 1 already ran in a previous session.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${ADMIN:=$(openssl rand -hex 16)}"
: "${KEY_HASH_SECRET:=$(openssl rand -hex 32)}"
: "${PORT:=8788}"
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${P2_BUDGET_SEC:=180}"
: "${P3_COUNT:=3}"

mkdir -p /tmp/cap-test
rm -f data/gateway.db data/gateway.db-shm data/gateway.db-wal

KEY_HASH_SECRET="$KEY_HASH_SECRET" \
ADMIN_TOKEN="$ADMIN" PORT="$PORT" \
UPSTREAM_MODE=cpa CPA_BASE_URL="$CPA_BASE_URL" \
CPA_API_KEY="$CPA_API_KEY" \
UPSTREAM_TIMEOUT_MS=300000 \
bun src/index.ts > /tmp/gw23.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 0.2
done

KJ=$(curl -s -X POST "http://127.0.0.1:$PORT/admin/keys" \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d '{"label":"cap23","initial_credits":100000}')
SK=$(printf '%s' "$KJ" | grep -oE 'sk-img-[A-Za-z0-9_-]+')
echo "key=$SK"

echo
echo "==================================================================="
echo "PHASE 2: Sustained sequential img-standard, ${P2_BUDGET_SEC}s budget"
echo "==================================================================="
P2_START=$(date +%s)
P2_OK=0; P2_ERR=0; LATSUM=0; LATMIN=99999; LATMAX=0; i=0
while :; do
  NOW=$(date +%s)
  if [[ $((NOW - P2_START)) -ge $P2_BUDGET_SEC ]]; then break; fi
  i=$((i+1))
  T0=$(date +%s)
  H=$(curl -s -m 180 -o "/tmp/cap-test/p2-$i.json" -w "%{http_code}" \
    -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
    -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
    -d "{\"model\":\"img-standard\",\"prompt\":\"unique abstract pattern v$i\"}")
  T1=$(date +%s); D=$((T1-T0))
  if [[ "$H" == "200" ]]; then
    P2_OK=$((P2_OK+1)); LATSUM=$((LATSUM+D))
    [[ $D -lt $LATMIN ]] && LATMIN=$D
    [[ $D -gt $LATMAX ]] && LATMAX=$D
    echo "  [p2-$i] OK  dur=${D}s  ($(wc -c < /tmp/cap-test/p2-$i.json)B)"
  else
    P2_ERR=$((P2_ERR+1))
    echo "  [p2-$i] FAIL http=$H dur=${D}s body=$(head -c 200 /tmp/cap-test/p2-$i.json)"
  fi
done
P2_WALL=$(($(date +%s) - P2_START))
echo
echo "── Sustained summary"
echo "   ok=$P2_OK  err=$P2_ERR  wall=${P2_WALL}s"
if [[ $P2_OK -gt 0 ]]; then
  AVG=$((LATSUM/P2_OK))
  RPM=$(echo "scale=2; $P2_OK*60/$P2_WALL" | bc)
  RPD=$(echo "scale=0; $P2_OK*86400/$P2_WALL" | bc)
  echo "   latency: min=${LATMIN}s  avg=${AVG}s  max=${LATMAX}s"
  echo "   throughput: ${RPM} req/min  →  ~${RPD} req/day (linear extrapolation)"
fi

echo
echo "==================================================================="
echo "PHASE 3: 4K integrity — $P3_COUNT sequential img-4k-square"
echo "==================================================================="
for i in $(seq 1 $P3_COUNT); do
  T0=$(date +%s)
  H=$(curl -s -m 240 -o "/tmp/cap-test/p3-$i.json" -w "%{http_code}" \
    -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
    -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
    -d "{\"model\":\"img-4k-square\",\"prompt\":\"intricate close-up of a peacock feather, eye-spot detail, fine plumage texture, scientific illustration v$i\"}")
  T1=$(date +%s); D=$((T1-T0))
  if [[ "$H" == "200" ]] && grep -q b64_json "/tmp/cap-test/p3-$i.json"; then
    python3 - <<PY
import json, base64
j=json.load(open('/tmp/cap-test/p3-$i.json'))
b=base64.b64decode(j['data'][0]['b64_json'])
open('/tmp/cap-test/p3-$i.png','wb').write(b)
from PIL import Image
im=Image.open('/tmp/cap-test/p3-$i.png')
br = len(b) / (im.size[0]*im.size[1])
print(f"  [p3-$i] OK dur=${D}s size={im.size} mode={im.mode} bytes={len(b):,} bytes/px={br:.3f}")
PY
  else
    echo "  [p3-$i] FAIL http=$H body=$(head -c 200 /tmp/cap-test/p3-$i.json)"
  fi
done

echo
echo "=== final balance ==="
curl -s "http://127.0.0.1:$PORT/v1/usage" -H "Authorization: Bearer $SK" | head -c 500; echo

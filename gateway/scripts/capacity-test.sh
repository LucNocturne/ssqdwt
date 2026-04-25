#!/usr/bin/env bash
# Capacity test for single OAuth account through gateway -> CPA.
# Measures: burst concurrency, sustained throughput, 4K integrity under load.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${ADMIN:=$(openssl rand -hex 16)}"
: "${KEY_HASH_SECRET:=$(openssl rand -hex 32)}"
: "${PORT:=8787}"
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"

rm -f data/gateway.db data/gateway.db-shm data/gateway.db-wal
mkdir -p /tmp/cap-test
rm -rf /tmp/cap-test/*

KEY_HASH_SECRET="$KEY_HASH_SECRET" \
ADMIN_TOKEN="$ADMIN" PORT="$PORT" \
UPSTREAM_MODE=cpa CPA_BASE_URL="$CPA_BASE_URL" \
CPA_API_KEY="$CPA_API_KEY" \
UPSTREAM_TIMEOUT_MS=300000 \
bun src/index.ts > /tmp/gw.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 0.2
done

KJ=$(curl -s -X POST "http://127.0.0.1:$PORT/admin/keys" \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d '{"label":"capacity-test","initial_credits":100000}')
SK=$(printf '%s' "$KJ" | grep -oE 'sk-img-[A-Za-z0-9_-]+')
echo "key=$SK initial=100000"

# ---------- Phase 1: Burst (10 parallel, img-standard) ----------
echo
echo "==================================================================="
echo "PHASE 1: Burst — 10 concurrent img-standard requests, 180s window"
echo "==================================================================="
P1_START=$(date +%s)
for i in $(seq 1 10); do
  (
    T0=$(date +%s.%N)
    H=$(curl -s -m 180 -o "/tmp/cap-test/p1-$i.json" -w "%{http_code}" \
      -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
      -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
      -d "{\"model\":\"img-standard\",\"prompt\":\"a unique landscape painting #$i, varied composition\"}")
    T1=$(date +%s.%N)
    DUR=$(printf "%.1f" $(echo "$T1 - $T0" | bc -l))
    SIZE=$(wc -c < "/tmp/cap-test/p1-$i.json")
    echo "  [p1-$i] http=$H dur=${DUR}s body=${SIZE}B" >> /tmp/cap-test/p1.log
  ) &
done
wait
P1_END=$(date +%s)
P1_WALL=$((P1_END - P1_START))
sort /tmp/cap-test/p1.log
P1_OK=$(grep -c http=200 /tmp/cap-test/p1.log || true)
echo "  ── burst summary: $P1_OK/10 succeeded in ${P1_WALL}s (effective $(echo "scale=1; $P1_OK*60/$P1_WALL" | bc) req/min if linearized)"

# ---------- Phase 2: Sustained (sequential, 5 min) ----------
echo
echo "==================================================================="
echo "PHASE 2: Sustained — sequential img-standard, 300s budget"
echo "==================================================================="
P2_START=$(date +%s)
P2_OK=0
P2_ERR=0
LATS=()
i=0
while :; do
  NOW=$(date +%s)
  if [[ $((NOW - P2_START)) -ge 300 ]]; then break; fi
  i=$((i+1))
  T0=$(date +%s)
  H=$(curl -s -m 180 -o "/tmp/cap-test/p2-$i.json" -w "%{http_code}" \
    -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
    -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
    -d "{\"model\":\"img-standard\",\"prompt\":\"a unique abstract pattern #$i\"}")
  T1=$(date +%s)
  DUR=$((T1 - T0))
  if [[ "$H" == "200" ]]; then
    P2_OK=$((P2_OK+1))
    LATS+=($DUR)
    echo "  [p2-$i] OK dur=${DUR}s"
  else
    P2_ERR=$((P2_ERR+1))
    echo "  [p2-$i] FAIL http=$H body=$(head -c 200 /tmp/cap-test/p2-$i.json)"
  fi
done
P2_WALL=$(($(date +%s) - P2_START))
echo "  ── sustained summary: $P2_OK ok / $P2_ERR err in ${P2_WALL}s"
if [[ $P2_OK -gt 0 ]]; then
  RPM=$(echo "scale=2; $P2_OK*60/$P2_WALL" | bc)
  RPD=$(echo "scale=0; $P2_OK*86400/$P2_WALL" | bc)
  echo "  ── projected: ${RPM} req/min, ${RPD} req/day (linear extrapolation)"
fi

# ---------- Phase 3: 4K integrity ----------
echo
echo "==================================================================="
echo "PHASE 3: 4K integrity — 3 sequential img-4k-square"
echo "==================================================================="
for i in $(seq 1 3); do
  T0=$(date +%s)
  H=$(curl -s -m 240 -o "/tmp/cap-test/p3-$i.json" -w "%{http_code}" \
    -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
    -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
    -d "{\"model\":\"img-4k-square\",\"prompt\":\"detailed close-up of a peacock feather, high resolution, fine plumage texture #$i\"}")
  T1=$(date +%s)
  DUR=$((T1-T0))
  if [[ "$H" == "200" ]] && grep -q b64_json "/tmp/cap-test/p3-$i.json"; then
    python3 - <<PY
import json, base64, hashlib
j=json.load(open('/tmp/cap-test/p3-$i.json'))
b=base64.b64decode(j['data'][0]['b64_json'])
open('/tmp/cap-test/p3-$i.png','wb').write(b)
from PIL import Image
im=Image.open('/tmp/cap-test/p3-$i.png')
# entropy proxy: png file size / pixel count (lower = more compressible = blurrier)
ratio = len(b) / (im.size[0]*im.size[1])
h = hashlib.sha256(b).hexdigest()[:12]
print(f"  [p3-$i] OK dur=${DUR}s size={im.size} mode={im.mode} bytes={len(b)} bytes/px={ratio:.3f} sha={h}")
PY
  else
    echo "  [p3-$i] FAIL http=$H"
  fi
done

# ---------- final ----------
echo
echo "==================================================================="
echo "FINAL: balance + summary"
echo "==================================================================="
curl -s "http://127.0.0.1:$PORT/v1/usage" -H "Authorization: Bearer $SK"
echo
echo
echo "=== gateway log tail ==="
tail -5 /tmp/gw.log

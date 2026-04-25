#!/usr/bin/env bash
# Test Pro-tier ceiling: 4K + transparent background.
# 1. 4K via gateway (img-4k-square = 2048x2048 high)
# 2. Transparent via direct CPA call with background:"transparent"
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${ADMIN:=$(openssl rand -hex 16)}"
: "${KEY_HASH_SECRET:=$(openssl rand -hex 32)}"
: "${PORT:=8787}"
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"

rm -f data/gateway.db data/gateway.db-shm data/gateway.db-wal

echo "[*] starting gateway (cpa upstream, 240s timeout)..."
KEY_HASH_SECRET="$KEY_HASH_SECRET" \
ADMIN_TOKEN="$ADMIN" PORT="$PORT" \
UPSTREAM_MODE=cpa CPA_BASE_URL="$CPA_BASE_URL" \
CPA_API_KEY="$CPA_API_KEY" \
UPSTREAM_TIMEOUT_MS=240000 \
bun src/index.ts > /tmp/gw.log 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 0.2
done

KJ=$(curl -s -X POST "http://127.0.0.1:$PORT/admin/keys" \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d '{"label":"4k-transparent-test","initial_credits":1000}')
SK=$(printf '%s' "$KJ" | grep -oE 'sk-img-[A-Za-z0-9_-]+')
echo "key=$SK"

echo
echo "============================================================"
echo "TEST 1: 4K via gateway (img-4k-square 2048x2048 quality=high)"
echo "============================================================"
T0=$(date +%s)
H1=$(curl -s -m 240 -o /tmp/4k.json -w "%{http_code}" \
  -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
  -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
  -d '{"model":"img-4k-square","prompt":"a detailed photo of a Bengal tiger in a rainforest, sharp fur details, dramatic lighting"}')
T1=$(date +%s)
echo "  status=$H1  elapsed=$((T1-T0))s"
echo "  body_size=$(wc -c < /tmp/4k.json) bytes"
if grep -q b64_json /tmp/4k.json; then
  python3 -c "
import json,base64
j=json.load(open('/tmp/4k.json'))
b=base64.b64decode(j['data'][0]['b64_json'])
open('/tmp/4k.png','wb').write(b)
print(f'  png_size={len(b)} bytes')" 2>/dev/null
  file /tmp/4k.png
  identify /tmp/4k.png 2>/dev/null || python3 -c "from PIL import Image; im=Image.open('/tmp/4k.png'); print(f'  PIL: {im.size} mode={im.mode}')" 2>/dev/null
else
  echo "  body: $(head -c 300 /tmp/4k.json)"
fi

echo
echo "=========================================================================="
echo "TEST 2: transparent — direct CPA call with background='transparent'"
echo "=========================================================================="
T0=$(date +%s)
H2=$(curl -s -m 240 -o /tmp/tx.json -w "%{http_code}" \
  -X POST "$CPA_BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $CPA_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-image-2",
    "prompt":"a flat vector logo of a fox sitting facing forward, simple shapes, minimalist, isolated on transparent background, no shadows, no scenery",
    "n":1,
    "size":"1024x1024",
    "quality":"high",
    "background":"transparent",
    "output_format":"png"
  }')
T1=$(date +%s)
echo "  status=$H2  elapsed=$((T1-T0))s"
echo "  body_size=$(wc -c < /tmp/tx.json) bytes"
if grep -q b64_json /tmp/tx.json; then
  python3 -c "
import json,base64
j=json.load(open('/tmp/tx.json'))
b=base64.b64decode(j['data'][0]['b64_json'])
open('/tmp/tx.png','wb').write(b)
print(f'  png_size={len(b)} bytes')" 2>/dev/null
  file /tmp/tx.png
  python3 -c "
from PIL import Image
im=Image.open('/tmp/tx.png')
has_alpha = im.mode in ('RGBA','LA') or 'A' in im.getbands()
print(f'  size={im.size}  mode={im.mode}  alpha={has_alpha}')
if has_alpha:
    a = im.split()[-1]
    bbox = a.getbbox()
    extrema = a.getextrema()
    print(f'  alpha extrema={extrema}  visible_bbox={bbox}')
" 2>/dev/null
else
  echo "  body_head: $(head -c 500 /tmp/tx.json)"
fi

echo
echo "=== final balance ==="
curl -s "http://127.0.0.1:$PORT/v1/usage" -H "Authorization: Bearer $SK" | head -c 400; echo
echo "=== gateway log tail ==="
tail -10 /tmp/gw.log

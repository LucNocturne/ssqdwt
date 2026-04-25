#!/usr/bin/env bash
# Probe gpt-image-2 (resolution × aspect) full matrix.
# Resolutions: 1K (long-edge 1024), 2K (2048), 4K (3840)
# Aspects:     1:1, 4:3, 3:4, 16:9, 9:16
set -euo pipefail
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${CPA_API_KEY:?required}"

declare -A SIZES=(
  ["1k_1x1"]="1024x1024"   ["1k_16x9"]="1024x576"   ["1k_9x16"]="576x1024"
  ["1k_4x3"]="1024x768"    ["1k_3x4"]="768x1024"
  ["2k_1x1"]="2048x2048"   ["2k_16x9"]="2048x1152"  ["2k_9x16"]="1152x2048"
  ["2k_4x3"]="2048x1536"   ["2k_3x4"]="1536x2048"
  ["4k_1x1"]="3840x3840"   ["4k_16x9"]="3840x2160"  ["4k_9x16"]="2160x3840"
  ["4k_4x3"]="3840x2880"   ["4k_3x4"]="2880x3840"
)

# Iterate in printed order
KEYS=(
  1k_1x1 1k_4x3 1k_3x4 1k_16x9 1k_9x16
  2k_1x1 2k_4x3 2k_3x4 2k_16x9 2k_9x16
  4k_1x1 4k_4x3 4k_3x4 4k_16x9 4k_9x16
)

mkdir -p /tmp/matrix
rm -rf /tmp/matrix/*

printf "%-10s %-12s %-9s %-9s %-12s %s\n" "label" "request" "http" "wall(s)" "real_size" "bytes/note"
printf "%s\n" "----------------------------------------------------------------------------"

for k in "${KEYS[@]}"; do
  SZ=${SIZES[$k]}
  T0=$(date +%s)
  HTTP=$(curl -s -m 200 -o "/tmp/matrix/$k.json" -w "%{http_code}" \
    -X POST "$CPA_BASE_URL/v1/images/generations" \
    -H "Authorization: Bearer $CPA_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"gpt-image-2\",\"prompt\":\"a small red square on white background\",\"n\":1,\"size\":\"$SZ\",\"quality\":\"high\"}")
  T1=$(date +%s); D=$((T1-T0))
  if [[ "$HTTP" == "200" ]] && grep -q b64_json "/tmp/matrix/$k.json"; then
    INFO=$(python3 - <<PY
import json, base64, io
from PIL import Image
j=json.load(open('/tmp/matrix/$k.json'))
b=base64.b64decode(j['data'][0]['b64_json'])
open('/tmp/matrix/$k.png','wb').write(b)
im=Image.open(io.BytesIO(b))
print(f"{im.size[0]}x{im.size[1]}\t{len(b)}")
PY
)
    REAL=$(echo "$INFO" | cut -f1)
    BYTES=$(echo "$INFO" | cut -f2)
    printf "%-10s %-12s %-9s %-9s %-12s %s\n" "$k" "$SZ" "$HTTP" "$D" "$REAL" "$(numfmt --to=iec --suffix=B "$BYTES" 2>/dev/null || echo "${BYTES}B")"
  else
    ERR=$(python3 -c "
import json
try:
    j=json.load(open('/tmp/matrix/$k.json'))
    print(j.get('error',{}).get('message','unknown'))
except: print('parse-fail')
" 2>/dev/null)
    printf "%-10s %-12s %-9s %-9s %-12s %s\n" "$k" "$SZ" "$HTTP" "$D" "—" "$(echo "$ERR" | head -c 80)"
  fi
done

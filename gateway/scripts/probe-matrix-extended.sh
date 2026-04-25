#!/usr/bin/env bash
# Comprehensive parameter probe for gpt-image-2 via CPA.
# Covers: extended aspects, quality levels, output formats, background.
set -euo pipefail
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${CPA_API_KEY:?required}"
mkdir -p /tmp/probe2
rm -rf /tmp/probe2/*

PROMPT="a small red square on white background"
OUT=/tmp/probe2-result.tsv
echo -e "group\tlabel\tparams\thttp\twall_s\treal_size\tbytes\tnote" > "$OUT"

probe() {
  local group="$1" label="$2" params="$3"
  local fname="/tmp/probe2/${group}_${label//[^a-zA-Z0-9]/_}.json"
  local T0=$(date +%s)
  local HTTP=$(curl -s -m 200 -o "$fname" -w "%{http_code}" \
    -X POST "$CPA_BASE_URL/v1/images/generations" \
    -H "Authorization: Bearer $CPA_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"gpt-image-2\",\"prompt\":\"$PROMPT\",\"n\":1,$params}")
  local T1=$(date +%s); local D=$((T1-T0))
  if [[ "$HTTP" == "200" ]] && grep -q b64_json "$fname"; then
    local INFO=$(python3 - <<PY
import json, base64, io
from PIL import Image
j=json.load(open('$fname'))
b=base64.b64decode(j['data'][0]['b64_json'])
im=Image.open(io.BytesIO(b))
extra = ''
if 'A' in im.getbands():
    a = im.split()[-1].getextrema()
    extra = f' alpha_extrema={a}'
print(f"{im.size[0]}x{im.size[1]}\t{len(b)}\tmode={im.mode}{extra}")
PY
)
    local SZ=$(echo "$INFO" | cut -f1)
    local BYTES=$(echo "$INFO" | cut -f2)
    local NOTE=$(echo "$INFO" | cut -f3)
    echo -e "$group\t$label\t$params\t$HTTP\t$D\t$SZ\t$(numfmt --to=iec --suffix=B "$BYTES" 2>/dev/null || echo "$BYTES")\t$NOTE" >> "$OUT"
    printf "  [%s] %s OK %ds → %s %s %s\n" "$group" "$label" "$D" "$SZ" "$(numfmt --to=iec --suffix=B $BYTES 2>/dev/null)" "$NOTE"
  else
    local ERR=$(python3 -c "
import json
try:
    j=json.load(open('$fname'))
    e=j.get('error',{})
    print(f\"{e.get('code','?')}: {e.get('message','?')}\")
except: print('parse-fail')
" 2>/dev/null | head -c 100)
    echo -e "$group\t$label\t$params\t$HTTP\t$D\t-\t-\t$ERR" >> "$OUT"
    printf "  [%s] %s FAIL %s %ds → %s\n" "$group" "$label" "$HTTP" "$D" "$ERR"
  fi
}

echo "=== A. Extended aspect ratios at 2K (long-edge=2048) ==="
probe ASPECT_2K  "1x1"      '"size":"2048x2048","quality":"high"'
probe ASPECT_2K  "4x3"      '"size":"2048x1536","quality":"high"'
probe ASPECT_2K  "3x4"      '"size":"1536x2048","quality":"high"'
probe ASPECT_2K  "3x2"      '"size":"2048x1365","quality":"high"'
probe ASPECT_2K  "2x3"      '"size":"1365x2048","quality":"high"'
probe ASPECT_2K  "16x9"     '"size":"2048x1152","quality":"high"'
probe ASPECT_2K  "9x16"     '"size":"1152x2048","quality":"high"'
probe ASPECT_2K  "21x9"     '"size":"2048x878","quality":"high"'
probe ASPECT_2K  "9x21"     '"size":"878x2048","quality":"high"'
probe ASPECT_2K  "5x4"      '"size":"2048x1638","quality":"high"'
probe ASPECT_2K  "4x5"      '"size":"1638x2048","quality":"high"'
probe ASPECT_2K  "2x1"      '"size":"2048x1024","quality":"high"'
probe ASPECT_2K  "1x2"      '"size":"1024x2048","quality":"high"'

echo
echo "=== B. Quality levels at 1024x1024 ==="
probe QUALITY    "low"      '"size":"1024x1024","quality":"low"'
probe QUALITY    "medium"   '"size":"1024x1024","quality":"medium"'
probe QUALITY    "high"     '"size":"1024x1024","quality":"high"'
probe QUALITY    "auto"     '"size":"1024x1024","quality":"auto"'

echo
echo "=== C. output_format at 1024x1024 high ==="
probe FORMAT     "png"      '"size":"1024x1024","quality":"high","output_format":"png"'
probe FORMAT     "webp"     '"size":"1024x1024","quality":"high","output_format":"webp"'
probe FORMAT     "jpeg"     '"size":"1024x1024","quality":"high","output_format":"jpeg"'

echo
echo "=== D. background at 1024x1024 high ==="
probe BG         "auto"     '"size":"1024x1024","quality":"high","background":"auto"'
probe BG         "opaque"   '"size":"1024x1024","quality":"high","background":"opaque"'
probe BG         "transparent" '"size":"1024x1024","quality":"high","background":"transparent"'

echo
echo "=== Result table ==="
column -t -s $'\t' "$OUT" | head -50

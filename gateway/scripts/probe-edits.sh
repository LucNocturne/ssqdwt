#!/usr/bin/env bash
# Probe v2 /v1/images/edits 可行性 — 5 个一次性确认场景
# 跑前 export CPA_API_KEY=...
set -euo pipefail
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${MODEL:=gpt-image-2}"

OUT=${OUT:-/tmp/probe-edits}
mkdir -p "$OUT"
URL="$CPA_BASE_URL/v1/images/edits"

# 生成测试素材
python3 - "$OUT" <<'PY'
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
img = Image.new('RGB', (1024,1024), 'white')
d = ImageDraw.Draw(img)
d.ellipse([(384,384),(640,640)], fill='red')
img.save(f'{out}/in.png')
img2 = Image.new('RGB',(1024,1024),'lightblue')
d2 = ImageDraw.Draw(img2)
d2.rectangle([(300,300),(700,700)], fill='navy')
img2.save(f'{out}/in2.png')
m = Image.new('RGBA',(1024,1024),(0,0,0,0))
ImageDraw.Draw(m).rectangle([(384,384),(640,640)], fill=(255,255,255,255))
m.save(f'{out}/mask.png')
PY

run() {
  local label="$1"; shift
  local file="$OUT/${label}.json"
  local T0=$(date +%s)
  local HTTP=$(curl -s -m 180 -o "$file" -w "%{http_code}" \
    -X POST "$URL" -H "Authorization: Bearer $CPA_API_KEY" "$@")
  local T1=$(date +%s)
  echo "[$label] HTTP=$HTTP wall=$((T1-T0))s body=$(wc -c < "$file")B"
}

echo "===== TEST 1 单图 image 字段 ====="
run t1 -F "model=$MODEL" -F "prompt=replace red circle with blue square" \
       -F "image=@$OUT/in.png" -F "n=1" -F "size=1024x1024"

echo "===== TEST 2 model 别名 gpt-image-1 vs gpt-image-2 ====="
run t2 -F "model=gpt-image-1" -F "prompt=add a yellow border" \
       -F "image=@$OUT/in.png" -F "n=1" -F "size=1024x1024"

echo "===== TEST 3 image + mask inpainting ====="
run t3 -F "model=$MODEL" -F "prompt=put a yellow star in the masked area" \
       -F "image=@$OUT/in.png" -F "mask=@$OUT/mask.png" -F "n=1" -F "size=1024x1024"

echo "===== TEST 4 image[] multi-ref 2 张 ====="
run t4 -F "model=$MODEL" -F "prompt=combine the two images" \
       -F "image[]=@$OUT/in.png" -F "image[]=@$OUT/in2.png" -F "n=1" -F "size=1024x1024"

echo
echo "===== usage 字段汇总 ====="
python3 - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
for n in ('t1','t2','t3','t4'):
    p = f'{out}/{n}.json'
    if not os.path.exists(p): continue
    try:
        j = json.load(open(p))
        u = j.get('usage')
        ok = 'data' in j and j['data'] and 'b64_json' in j['data'][0]
        print(f'{n}: ok={ok} usage={u}')
    except Exception as e:
        print(f'{n}: parse fail {e}')
PY

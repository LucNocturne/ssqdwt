#!/usr/bin/env bash
# smoke 网关本身的 /v1/images/edits — 5 个场景验收
# 跑前:
#   export GATEWAY_URL=http://localhost:8787
#   export GATEWAY_KEY=sk-img-...     # 网关 key,不是 CPA key
#   export MODEL=img-standard         # 默认 1k 1024x1024 medium
set -euo pipefail
: "${GATEWAY_URL:=http://localhost:8787}"
: "${GATEWAY_KEY:?GATEWAY_KEY env required (sk-img-...)}"
: "${MODEL:=img-standard}"
: "${MAX_INPUT_IMAGE_BYTES:=4194304}"

OUT=${OUT:-/tmp/smoke-edits}
mkdir -p "$OUT"
URL="$GATEWAY_URL/v1/images/edits"

# 测试素材
python3 - "$OUT" <<'PY'
import sys, os
try:
    from PIL import Image, ImageDraw
except ImportError:
    print('smoke-edits.sh requires Pillow: python3 -m pip install pillow', file=sys.stderr)
    raise SystemExit(1)
out = sys.argv[1]
img = Image.new('RGB', (1024,1024), 'white')
ImageDraw.Draw(img).ellipse([(384,384),(640,640)], fill='red')
img.save(f'{out}/in.png')
img2 = Image.new('RGB',(1024,1024),'lightblue')
ImageDraw.Draw(img2).rectangle([(300,300),(700,700)], fill='navy')
img2.save(f'{out}/in2.png')
m = Image.new('RGBA',(1024,1024),(0,0,0,0))
ImageDraw.Draw(m).rectangle([(384,384),(640,640)], fill=(255,255,255,255))
m.save(f'{out}/mask.png')
# bad: wrong-size mask
m_bad = Image.new('RGBA',(512,512),(0,0,0,0))
m_bad.save(f'{out}/mask_bad.png')
# big image: random pixel data is incompressible, guarantees size > MAX_INPUT_IMAGE_BYTES
limit = int(os.environ['MAX_INPUT_IMAGE_BYTES'])
side = max(512, int((limit / 3) ** 0.5) + 1024)
while True:
    big = Image.frombytes('RGB', (side, side), os.urandom(side*side*3))
    big.save(f'{out}/big.png', optimize=False, compress_level=0)
    size = os.path.getsize(f'{out}/big.png')
    if size > limit:
        break
    side *= 2
print(f"big.png size: {size} bytes (limit={limit})")
assert size > limit, f"big.png is only {size}B; need >{limit}B to trigger 413"
PY

run() {
  local label="$1"; shift
  local want="$1"; shift
  local file="$OUT/${label}.json"
  local T0=$(date +%s)
  local HTTP=$(curl -s -m 180 -o "$file" -w "%{http_code}" \
    -X POST "$URL" -H "Authorization: Bearer $GATEWAY_KEY" "$@")
  local T1=$(date +%s)
  echo "[$label] HTTP=$HTTP want=$want wall=$((T1-T0))s body=$(wc -c < "$file")B"
  if [[ "$HTTP" != "$want" ]]; then
    echo "[$label] expected HTTP $want, got $HTTP" >&2
    return 1
  fi
}

echo "===== TEST 1 单图 happy path ====="
run t1 200 -F "model=$MODEL" -F "prompt=replace red circle with blue square" \
       -F "image=@$OUT/in.png" -F "n=1"

echo "===== TEST 2 image + mask inpainting ====="
run t2 200 -F "model=$MODEL" -F "prompt=put a yellow star in the masked area" \
       -F "image=@$OUT/in.png" -F "mask=@$OUT/mask.png" -F "n=1"

echo "===== TEST 3 multi-ref image[] ====="
run t3 200 -F "model=$MODEL" -F "prompt=combine the two images" \
       -F "image[]=@$OUT/in.png" -F "image[]=@$OUT/in2.png" -F "n=1"

echo "===== TEST 4 mask 尺寸不符 → 400 ====="
run t4 400 -F "model=$MODEL" -F "prompt=x" \
       -F "image=@$OUT/in.png" -F "mask=@$OUT/mask_bad.png"

echo "===== TEST 5 错误 model id → 400 ====="
run t5 400 -F "model=img-fake-666" -F "prompt=x" -F "image=@$OUT/in.png"

echo "===== TEST 6 超大图 → 413(若 > MAX_INPUT_IMAGE_BYTES) ====="
run t6 413 -F "model=$MODEL" -F "prompt=x" -F "image=@$OUT/big.png"

echo
echo "===== 验收摘要 ====="
python3 - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
expectations = {
  't1': ('200', '单图 happy'),
  't2': ('200', 'mask inpainting'),
  't3': ('200', 'multi-ref'),
  't4': ('400', 'mask size mismatch'),
  't5': ('400', 'unknown model'),
  't6': ('413', 'image too large'),
}
for label, (want, desc) in expectations.items():
    p = f'{out}/{label}.json'
    if not os.path.exists(p):
        print(f'{label}: NO OUTPUT — {desc}')
        continue
    try:
        j = json.load(open(p))
        if 'data' in j and j['data']:
            usage = j.get('usage', {})
            print(f'{label}: ok b64={"yes" if j["data"][0].get("b64_json") else "no"} '
                  f'credits={usage.get("credits")} input_tokens={usage.get("input_tokens")}'
                  f' — {desc}')
        elif 'error' in j:
            print(f'{label}: error.type={j["error"].get("type")} '
                  f'msg={j["error"].get("message")[:80]} — {desc}')
        else:
            print(f'{label}: unknown shape — {desc}')
    except Exception as e:
        print(f'{label}: parse fail {e} — {desc}')
PY

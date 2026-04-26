#!/usr/bin/env bash
# 持续并发跑满目标成功数 (默认 1000) 的 4K 图,自动重试 429/502。
#
# 与 concurrency-limit.sh 不同:
#   - 那个测"瞬时极限并发"(barrier 同步发 N 个) → 撞上游限流
#   - 这个测"可持续并发吞吐",维持 K 路 workpool,直到攒够目标 OK 数
#
# 用法:
#   CPA_API_KEY=... ./scripts/sustained-1000.sh                    # 默认 K=20, TARGET=1000
#   CPA_API_KEY=... TARGET=200 K=10 ./scripts/sustained-1000.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${ADMIN:=$(openssl rand -hex 16)}"
: "${KEY_HASH_SECRET:=$(openssl rand -hex 32)}"
: "${PORT:=8788}"
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${MODEL:=img-4k-3840x2160}"
: "${REQ_TIMEOUT:=600}"
: "${CREDIT_PER_CALL:=16}"
: "${TARGET:=1000}"           # 目标成功数
: "${K:=20}"                  # workpool 大小
: "${MAX_RETRIES:=5}"         # 单请求最多重试次数 (429/502/超时)
: "${MAX_BUDGET_MULT:=4}"     # 总预算 = TARGET × CREDIT_PER_CALL × 该倍数 (留给重试)
: "${PROMPT_PREFIX:=simple blue cube}" # 短 prompt；复杂 prompt 会把 4K 拉到 ~180s+ 并触发上游断流

EXPECTED_W=$(printf '%s' "$MODEL" | sed -nE 's/.*-([0-9]+)x([0-9]+).*/\1/p')
EXPECTED_H=$(printf '%s' "$MODEL" | sed -nE 's/.*-([0-9]+)x([0-9]+).*/\2/p')
[[ -z "$EXPECTED_W" || -z "$EXPECTED_H" ]] && { echo "cannot parse expected dim"; exit 1; }

WORKDIR=/tmp/sustained-1000
rm -rf "$WORKDIR"; mkdir -p "$WORKDIR"
OK_DIR="$WORKDIR/ok"; mkdir -p "$OK_DIR"
ATT_LOG="$WORKDIR/attempts.tsv"      # 每次 attempt 一行: worker_id seq http dur start retries
STOP_FLAG="$WORKDIR/STOP"
: >"$ATT_LOG"

# --- boot gateway ---
rm -f data/gateway.db data/gateway.db-shm data/gateway.db-wal
KEY_HASH_SECRET="$KEY_HASH_SECRET" \
ADMIN_TOKEN="$ADMIN" PORT="$PORT" \
UPSTREAM_MODE=cpa CPA_BASE_URL="$CPA_BASE_URL" \
CPA_API_KEY="$CPA_API_KEY" \
UPSTREAM_TIMEOUT_MS=$((REQ_TIMEOUT*1000)) \
bun src/index.ts > "$WORKDIR/gw.log" 2>&1 &
GW_PID=$!
trap 'kill "$GW_PID" 2>/dev/null || true; pkill -P $$ 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done

BUDGET=$((TARGET * CREDIT_PER_CALL * MAX_BUDGET_MULT))
KJ=$(curl -fsS -X POST "http://127.0.0.1:$PORT/admin/keys" \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d "{\"label\":\"sustained-test\",\"initial_credits\":$BUDGET}")
SK=$(printf '%s' "$KJ" | grep -oE 'sk-img-[A-Za-z0-9_-]+')

T_START=$(date +%s.%N)
echo "key=$SK budget=${BUDGET}cr  target=$TARGET  K=$K  model=$MODEL  expected=${EXPECTED_W}x${EXPECTED_H}"
echo "begin: $(date '+%H:%M:%S')"
echo

# ---- worker ----
worker() {
  local wid=$1
  local seq=0
  while [[ ! -e "$STOP_FLAG" ]]; do
    seq=$((seq+1))
    local retries=0 backoff=2.0 final_http="" final_dur=""
    while :; do
      local rid="w${wid}-s${seq}-r${retries}"
      local outfile="$WORKDIR/tmp-$rid.json"
      local errfile="$WORKDIR/tmp-$rid.err"
      local t0 t1 dur http
      t0=$(date +%s.%N)
      http=$(curl -s -m "$REQ_TIMEOUT" -o "$outfile" -w "%{http_code}" \
        -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
        -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
        -d "{\"model\":\"$MODEL\",\"prompt\":\"$PROMPT_PREFIX #${wid}-${seq}-${retries}\"}" \
        2>"$errfile" || echo "000")
      t1=$(date +%s.%N)
      dur=$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f", b-a}')

      if [[ "$http" == "200" ]]; then
        # 原子计数:用 mkdir 抢占 ok 槽位
        local cnt
        cnt=$(ls "$OK_DIR" 2>/dev/null | wc -l)
        if [[ $cnt -lt $TARGET ]]; then
          local slot="$OK_DIR/$(printf '%05d' $((cnt+1)))-$rid"
          if mkdir "$slot" 2>/dev/null; then
            mv "$outfile" "$slot/img.json"
          else
            rm -f "$outfile"
          fi
          # 触发 stop 时机:每次成功都重新数
          local newcnt
          newcnt=$(ls "$OK_DIR" 2>/dev/null | wc -l)
          if [[ $newcnt -ge $TARGET ]]; then : >"$STOP_FLAG"; fi
        else
          rm -f "$outfile"
        fi
        final_http=200; final_dur=$dur
        break
      fi

      rm -f "$outfile" "$errfile"
      retries=$((retries+1))
      if [[ $retries -ge $MAX_RETRIES ]]; then
        final_http=$http; final_dur=$dur
        break
      fi
      # 退避
      case "$http" in
        429) sleep "$(awk -v b="$backoff" 'BEGIN{srand(); printf "%.2f", b + rand()*1.5}')"; backoff=$(awk -v b="$backoff" 'BEGIN{printf "%.2f", b*1.5}');;
        502|503|504) sleep 0.5 ;;
        000) sleep 1.0 ;;   # curl error / timeout
        *)   final_http=$http; final_dur=$dur; break ;;  # 其他 4xx 不重试
      esac
    done
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$wid" "$seq" "$final_http" "$final_dur" "$(date +%s.%N)" "$retries" >>"$ATT_LOG"
  done
}

# ---- progress reporter ----
reporter() {
  local last=0
  while [[ ! -e "$STOP_FLAG" ]]; do
    sleep 10
    local cnt elapsed atts
    cnt=$(ls "$OK_DIR" 2>/dev/null | wc -l)
    atts=$(wc -l <"$ATT_LOG" 2>/dev/null || echo 0)
    elapsed=$(awk -v a="$T_START" -v b="$(date +%s.%N)" 'BEGIN{printf "%.0f", b-a}')
    local rate
    rate=$(awk -v c="$cnt" -v e="$elapsed" 'BEGIN{ if(e==0){print 0}else{printf "%.2f", c*60/e} }')
    printf '[%4ss] ok=%d/%d  attempts=%s  rate=%s/min\n' "$elapsed" "$cnt" "$TARGET" "$atts" "$rate"
    last=$cnt
  done
}

# ---- launch ----
PIDS=()
for w in $(seq 1 "$K"); do worker "$w" & PIDS+=($!); done
reporter &
REP_PID=$!
wait "${PIDS[@]}"
kill "$REP_PID" 2>/dev/null || true
wait "$REP_PID" 2>/dev/null || true

T_END=$(date +%s.%N)
WALL=$(awk -v a="$T_START" -v b="$T_END" 'BEGIN{printf "%.1f", b-a}')

echo
echo "==================================================================="
echo "DONE   ok=$(ls "$OK_DIR" | wc -l)/$TARGET  wall=${WALL}s"
echo "==================================================================="

# ---- attempt 分布 ----
echo
echo "── attempt distribution"
awk -F'\t' '{ c[$3]++ } END{ for (k in c) printf "  http=%-4s count=%d\n", k, c[k] | "sort -k4 -n -r" }' "$ATT_LOG"
total_att=$(wc -l <"$ATT_LOG")
total_retries=$(awk -F'\t' '{s+=$6} END{print s+0}' "$ATT_LOG")
echo "  ── total attempts=$total_att   total retries=$total_retries"

# ---- 延迟 (200 only) ----
echo
echo "── ok latency"
awk -F'\t' '$3==200{print $4}' "$ATT_LOG" | sort -n >"$WORKDIR/lat.txt"
if [[ -s "$WORKDIR/lat.txt" ]]; then
  awk '{a[NR]=$1} END{
    n=NR
    p50=a[int(n*0.5)]; p95=a[int(n*0.95)]; p99=a[int(n*0.99)]
    s=0; for(i=1;i<=n;i++) s+=a[i]
    printf "  n=%d  min=%.2f  mean=%.2f  p50=%.2f  p95=%.2f  p99=%.2f  max=%.2f\n", n, a[1], s/n, p50, p95, p99, a[n]
  }' "$WORKDIR/lat.txt"
fi

# ---- 质量分析 ----
echo
echo "── image quality (decoding all OK images)"
python3 - "$OK_DIR" "$EXPECTED_W" "$EXPECTED_H" <<'PY'
import sys, os, json, base64, hashlib, statistics, glob
from io import BytesIO
from PIL import Image
ok_dir, ew, eh = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
slots = sorted(glob.glob(os.path.join(ok_dir, "*")))
n = len(slots)
decoded=0; dim_match=0; mismatches=[]; sizes=[]; hashes={}; modes={}
for s in slots:
    fp = os.path.join(s, "img.json")
    try:
        j = json.load(open(fp))
        raw = base64.b64decode(j["data"][0]["b64_json"])
    except Exception:
        continue
    decoded += 1
    sizes.append(len(raw))
    h = hashlib.sha256(raw).hexdigest()
    hashes.setdefault(h, []).append(os.path.basename(s))
    try:
        im = Image.open(BytesIO(raw))
        modes[im.mode] = modes.get(im.mode, 0) + 1
        if im.size == (ew, eh): dim_match += 1
        else: mismatches.append((os.path.basename(s), im.size))
    except Exception as e:
        mismatches.append((os.path.basename(s), f"err:{e}"))
print(f"  total_slots={n}  decoded={decoded}  dim_match={dim_match}/{decoded}  expected={ew}x{eh}  modes={modes}")
if sizes:
    print(f"  png bytes  min={min(sizes):>9}  median={int(statistics.median(sizes)):>9}  max={max(sizes):>9}  mean={int(statistics.mean(sizes)):>9}  total={sum(sizes)/1024/1024:.1f} MB")
    bp=[s/(ew*eh) for s in sizes]
    print(f"  bytes/pixel  min={min(bp):.3f}  median={statistics.median(bp):.3f}  max={max(bp):.3f}")
dups = {k:v for k,v in hashes.items() if len(v)>1}
if dups:
    print(f"  WARN: {len(dups)} duplicate hashes:")
    for h, ids in list(dups.items())[:3]: print(f"    sha={h[:12]}  slots={ids[:5]}")
else:
    print(f"  uniqueness OK: all {decoded} hashes distinct")
if mismatches:
    print(f"  WARN: {len(mismatches)} dim mismatches; first 5: {mismatches[:5]}")
PY

# ---- 配额账面 ----
echo
echo "── local gateway accounting"
curl -s "http://127.0.0.1:$PORT/v1/usage" -H "Authorization: Bearer $SK" | python3 -m json.tool || true

echo
echo "── gateway log tail (errors)"
grep -E "upstream_error|status=4|status=5" "$WORKDIR/gw.log" | tail -10

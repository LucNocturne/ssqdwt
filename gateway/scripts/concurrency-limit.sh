#!/usr/bin/env bash
# 极限并发压测：通过 gateway -> CPA -> OpenAI,测试单账号在高并发下的实际吞吐和失败模式。
#
# 设计：
#   - 同时刻发出 N 个 /v1/images/generations,记录每条 dispatch/return 时间、http、字节数
#   - 用 img-1k-1024x1024-low (最便宜 1cr + low quality 出图最快) 减小成本和单请求时长
#   - 输出:成功率、p50/p95/p99 延迟、错误分类(超时/HTTP 502/4xx/CPA refund)、首/末请求 wall 差
#
# 用法:
#   CPA_API_KEY=sk-... ./scripts/concurrency-limit.sh         # 默认依次跑 20, 100
#   CPA_API_KEY=sk-... ./scripts/concurrency-limit.sh 20      # 只跑 20
#   CPA_API_KEY=sk-... ./scripts/concurrency-limit.sh 50 200  # 自定义
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CPA_API_KEY:?CPA_API_KEY env required}"
: "${ADMIN:=$(openssl rand -hex 16)}"
: "${KEY_HASH_SECRET:=$(openssl rand -hex 32)}"
: "${PORT:=8788}"
: "${CPA_BASE_URL:=https://codemo.zeabur.app}"
: "${MODEL:=img-1k-1024x1024-low}"
: "${REQ_TIMEOUT:=300}"   # 单请求 curl 超时 (s),给上游够大空间

PHASES=("${@:-20 100}")
read -r -a PHASES <<<"${PHASES[*]}"

WORKDIR=/tmp/concurrency-limit
rm -rf "$WORKDIR"; mkdir -p "$WORKDIR"

# --- boot local gateway ---
rm -f data/gateway.db data/gateway.db-shm data/gateway.db-wal
KEY_HASH_SECRET="$KEY_HASH_SECRET" \
ADMIN_TOKEN="$ADMIN" PORT="$PORT" \
UPSTREAM_MODE=cpa CPA_BASE_URL="$CPA_BASE_URL" \
CPA_API_KEY="$CPA_API_KEY" \
UPSTREAM_TIMEOUT_MS=$((REQ_TIMEOUT*1000)) \
bun src/index.ts > "$WORKDIR/gw.log" 2>&1 &
GW_PID=$!
trap 'kill "$GW_PID" 2>/dev/null || true' EXIT

# wait until /health is up
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done

# mint key with abundant credits (100 calls @1cr = 100; give buffer)
TOTAL_NEEDED=0
for n in "${PHASES[@]}"; do TOTAL_NEEDED=$((TOTAL_NEEDED + n*5)); done
KJ=$(curl -fsS -X POST "http://127.0.0.1:$PORT/admin/keys" \
  -H "X-Admin-Token: $ADMIN" -H "Content-Type: application/json" \
  -d "{\"label\":\"concurrency-test\",\"initial_credits\":$TOTAL_NEEDED}")
SK=$(printf '%s' "$KJ" | grep -oE 'sk-img-[A-Za-z0-9_-]+')
echo "key=$SK initial_credits=$TOTAL_NEEDED model=$MODEL"
echo

# --- helpers ---
# percentile p of a sorted ascending file of numbers (one per line)
pctile() {
  local p=$1 file=$2
  awk -v p="$p" '
    { a[NR]=$1 }
    END {
      if (NR==0) { print "n/a"; exit }
      idx = int(NR * p / 100); if (idx<1) idx=1; if (idx>NR) idx=NR
      printf "%.2f", a[idx]
    }' "$file"
}

run_phase() {
  local N=$1
  local DIR="$WORKDIR/phase-$N"
  mkdir -p "$DIR"
  echo "==================================================================="
  echo "PHASE: $N concurrent  (model=$MODEL, timeout=${REQ_TIMEOUT}s/req)"
  echo "==================================================================="

  # Barrier: pre-fork all N workers, each blocks on the gate file existing.
  # Then we touch the gate at one instant -> all curl POSTs fire near-simultaneously
  # (typical jitter <5ms vs naive "for i; do (...) &" which spreads over hundreds of ms).
  local GATE="$DIR/gate"
  rm -f "$GATE"

  for i in $(seq 1 "$N"); do
    (
      while [[ ! -e "$GATE" ]]; do :; done
      local T0 T1 H BYTES DUR ERRSAMPLE=""
      T0=$(date +%s.%N)
      H=$(curl -s -m "$REQ_TIMEOUT" -o "$DIR/r-$i.json" -w "%{http_code}" \
        -X POST "http://127.0.0.1:$PORT/v1/images/generations" \
        -H "Authorization: Bearer $SK" -H "Content-Type: application/json" \
        -d "{\"model\":\"$MODEL\",\"prompt\":\"unique abstract pattern variant #$i, distinct composition\"}" \
        2>"$DIR/r-$i.err" || echo "000")
      T1=$(date +%s.%N)
      BYTES=$(wc -c <"$DIR/r-$i.json" 2>/dev/null || echo 0)
      DUR=$(awk -v a="$T0" -v b="$T1" 'BEGIN{printf "%.3f", b-a}')
      if [[ "$H" != "200" ]]; then
        ERRSAMPLE=$(head -c 160 "$DIR/r-$i.json" 2>/dev/null | tr '\n' ' ')
        [[ -z "$ERRSAMPLE" ]] && ERRSAMPLE=$(head -c 160 "$DIR/r-$i.err" 2>/dev/null | tr '\n' ' ')
      fi
      # 7 cols: id  http  dur  bytes  start_ts  end_ts  err
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$i" "$H" "$DUR" "$BYTES" "$T0" "$T1" "$ERRSAMPLE" \
        >>"$DIR/results.tsv"
    ) &
  done

  sleep 0.5  # let all workers reach the spin
  local WALL_START
  WALL_START=$(date +%s.%N)
  : >"$GATE"   # release: all N curls fire here

  wait
  local WALL_END WALL
  WALL_END=$(date +%s.%N)
  WALL=$(awk -v a="$WALL_START" -v b="$WALL_END" 'BEGIN{printf "%.2f", b-a}')

  # --- aggregate ---
  sort -n "$DIR/results.tsv" -o "$DIR/results.tsv"
  local OK FAIL TIMEOUTS HTTP502 HTTP4XX OTHER
  OK=$(awk -F'\t' '$2=="200"' "$DIR/results.tsv" | wc -l)
  FAIL=$((N - OK))
  TIMEOUTS=$(awk -F'\t' '$2=="000"' "$DIR/results.tsv" | wc -l)
  HTTP502=$(awk -F'\t' '$2=="502" || $2=="503" || $2=="504"' "$DIR/results.tsv" | wc -l)
  HTTP4XX=$(awk -F'\t' '$2~/^4/' "$DIR/results.tsv" | wc -l)
  OTHER=$((FAIL - TIMEOUTS - HTTP502 - HTTP4XX))

  # latency stats over OK only
  awk -F'\t' '$2=="200"{print $3}' "$DIR/results.tsv" | sort -n >"$DIR/lat-ok.txt"
  awk -F'\t' '$2!="200"{print $3}' "$DIR/results.tsv" | sort -n >"$DIR/lat-fail.txt"

  echo "── per-request (sorted by request id):"
  awk -F'\t' '{
    code=$2; dur=$3; bytes=$4; err=$6
    tag = (code=="200") ? "OK" : "FAIL"
    if (code=="200") printf "  [#%-3s] %-4s http=%-3s dur=%6.2fs bytes=%s\n", $1, tag, code, dur, bytes
    else             printf "  [#%-3s] %-4s http=%-3s dur=%6.2fs err=%s\n",   $1, tag, code, dur, err
  }' "$DIR/results.tsv"

  echo
  echo "── concurrency signals"
  # dispatch_span = max(start_ts) - min(start_ts);  小 → barrier 真把它们同时推出去了
  # completion_span = max(end_ts) - min(end_ts);   小 → 上游真并行;接近 wall → 串行/排队
  # max_in_flight = 时间窗扫描下,最高同时存活数 (event sweep over [start,end] intervals)
  # first_fail_offset = 第一次出现非 200 的 (start - WALL_START)
  awk -F'\t' -v ws="$WALL_START" '
    {
      start[NR]=$5; end[NR]=$6; code[NR]=$2
      if (NR==1) { smin=$5; smax=$5; emin=$6; emax=$6 }
      if ($5<smin) smin=$5; if ($5>smax) smax=$5
      if ($6<emin) emin=$6; if ($6>emax) emax=$6
      ev[++ec]=$5"\tup";  ev[++ec]=$6"\tdn"
      if ($2!="200" && (ff_off=="" || $5<ff_t)) { ff_off=$5-ws; ff_t=$5; ff_code=$2 }
    }
    END {
      printf "  dispatch_span    = %.3fs  (gap between first & last request leaving)\n", smax-smin
      printf "  completion_span  = %.3fs  (gap between first & last request returning)\n", emax-emin
      # sort events
      n=ec
      for (i=1;i<=n;i++) for (j=i+1;j<=n;j++) {
        split(ev[i],a,"\t"); split(ev[j],b,"\t")
        if (a[1]+0 > b[1]+0) { tmp=ev[i]; ev[i]=ev[j]; ev[j]=tmp }
      }
      cur=0; mx=0
      for (i=1;i<=n;i++) {
        split(ev[i],p,"\t")
        if (p[2]=="up") cur++; else cur--
        if (cur>mx) mx=cur
      }
      printf "  max_in_flight    = %d  (peak overlapping requests; ≈N → upstream parallel, ≈1 → serialized)\n", mx
      if (ff_off!="") printf "  first_fail_at    = %.2fs after launch  (http=%s)\n", ff_off, ff_code
      else            printf "  first_fail_at    = none\n"
    }' "$DIR/results.tsv"
  echo
  echo "── summary"
  printf "  total=%d  ok=%d  fail=%d  (timeout=%d 5xx=%d 4xx=%d other=%d)\n" \
    "$N" "$OK" "$FAIL" "$TIMEOUTS" "$HTTP502" "$HTTP4XX" "$OTHER"
  printf "  wall=%ss   throughput=%.2f req/s\n" "$WALL" \
    "$(awk -v n="$OK" -v w="$WALL" 'BEGIN{ if(w==0){print 0}else{printf "%.2f", n/w} }')"
  if [[ $OK -gt 0 ]]; then
    local P50 P95 P99 PMAX PMIN
    P50=$(pctile 50 "$DIR/lat-ok.txt")
    P95=$(pctile 95 "$DIR/lat-ok.txt")
    P99=$(pctile 99 "$DIR/lat-ok.txt")
    PMIN=$(head -1 "$DIR/lat-ok.txt")
    PMAX=$(tail -1 "$DIR/lat-ok.txt")
    printf "  ok latency  min=%ss  p50=%ss  p95=%ss  p99=%ss  max=%ss\n" \
      "$PMIN" "$P50" "$P95" "$P99" "$PMAX"
  fi

  # 错误样本 (前 5 条不同 http)
  local ERR_LINES
  ERR_LINES=$(awk -F'\t' '$2!="200"{ key=$2; if (!(key in seen)) { seen[key]=1; print } }' "$DIR/results.tsv" | head -5)
  if [[ -n "$ERR_LINES" ]]; then
    echo "── distinct error samples:"
    echo "$ERR_LINES" | awk -F'\t' '{ printf "  http=%s  dur=%ss  err=%s\n", $2, $3, $6 }'
  fi

  # 余额
  echo "── balance after phase:"
  curl -fsS "http://127.0.0.1:$PORT/v1/usage" -H "Authorization: Bearer $SK" \
    | python3 -c 'import json,sys;j=json.load(sys.stdin);print(f"  remaining={j.get(\"credits_remaining\",\"?\")}  used={j.get(\"credits_used\",\"?\")}")' \
    || true
  echo
}

# --- run phases ---
for N in "${PHASES[@]}"; do
  run_phase "$N"
  # cool-off between phases so we don't double-stress upstream
  if [[ "$N" != "${PHASES[-1]}" ]]; then
    echo "(cooling off 30s before next phase…)"; sleep 30; echo
  fi
done

echo "==================================================================="
echo "DONE   raw artifacts: $WORKDIR"
echo "==================================================================="
echo "── gateway log tail:"
tail -10 "$WORKDIR/gw.log"

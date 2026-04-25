/**
 * 简易压测脚本:对网关发 N 个并发请求 × M 总数,统计耗时分布与错误率。
 * 用法:
 *   bun scripts/loadtest.ts <url> <api_key> <concurrency> <total> [model]
 * 例:
 *   bun scripts/loadtest.ts http://127.0.0.1:8787 sk-img-xxx 50 1000 img-standard
 */

const [, , url, apiKey, cStr, tStr, modelArg] = process.argv;
if (!url || !apiKey || !cStr || !tStr) {
  console.error("usage: bun scripts/loadtest.ts <url> <key> <concurrency> <total> [model]");
  process.exit(2);
}
const concurrency = Number(cStr);
const total = Number(tStr);
const model = modelArg ?? "img-standard";
const endpoint = `${url.replace(/\/$/, "")}/v1/images/generations`;

const latencies: number[] = [];
let success = 0;
let failed = 0;
let inFlight = 0;
let issued = 0;

const startWall = Date.now();

async function one() {
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt: "loadtest", n: 1 }),
    });
    await res.arrayBuffer(); // 把 body 读完,模拟真实客户端
    const dt = performance.now() - t0;
    latencies.push(dt);
    if (res.ok) success++;
    else failed++;
  } catch {
    latencies.push(performance.now() - t0);
    failed++;
  } finally {
    inFlight--;
  }
}

async function worker() {
  while (issued < total) {
    if (inFlight >= concurrency) {
      await new Promise((r) => setTimeout(r, 1));
      continue;
    }
    issued++;
    inFlight++;
    one();
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
while (inFlight > 0) await new Promise((r) => setTimeout(r, 5));

const elapsed = (Date.now() - startWall) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!;
const sum = latencies.reduce((a, b) => a + b, 0);

console.log("---");
console.log(`url:        ${endpoint}`);
console.log(`model:      ${model}`);
console.log(`concurrency:${concurrency}  total:${total}`);
console.log(`elapsed:    ${elapsed.toFixed(2)}s`);
console.log(`throughput: ${(total / elapsed).toFixed(1)} req/s`);
console.log(`success:    ${success}  failed:${failed}  err_rate:${((failed / total) * 100).toFixed(2)}%`);
console.log(`latency ms  avg:${(sum / latencies.length).toFixed(1)}`);
console.log(`            p50:${pct(0.5).toFixed(1)}  p95:${pct(0.95).toFixed(1)}  p99:${pct(0.99).toFixed(1)}  max:${pct(1).toFixed(1)}`);
console.log("---");

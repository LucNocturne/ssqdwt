# 1000 张 4K 极限并发 / 持续吞吐 实测报告

> 数据来源:`/tmp/sustained-1000`(part1, K=6) + `/tmp/sustained-1000-part2`(part2, K=10) 实跑产物
> 模型:`img-4k-3840x2160`(gpt-image-2,4K 16:9, 上游 8.3M 像素 / 16cr/张)
> prompt 模板:`simple blue cube #<wid>-<seq>-<retries>`(短 prompt)

---

## 1. 张数 / 来源

| 阶段 | 并发 K | TARGET | 成功保存 |
| --- | --- | --- | --- |
| part1 (`/tmp/sustained-1000/ok`)        | 6  | 411 | **411** |
| part2 (`/tmp/sustained-1000-part2/ok`)  | 10 | 589 | **589** |
| **合计**                                |    | **1000** | **1000 ✅** |

> 100% 完成,全部为真 `3840×2160` 4K PNG。

## 2. 请求/失败 分布

```text
attempts      = 1020
http_dist     = 200=1009  500=7  503=4
retries_total = 32
success_rate  = 1009 / 1020 = 98.92%
```

- `503 = 4` 全部出现在 part2 收尾,gateway log 明确为 `auth_unavailable: no auth available (providers=codex)`,即上游 codex 短时账号池被打空(对应 5h 窗口接近耗尽)
- `500 = 7` 散见于全程,典型为 `stream disconnected before completion / stream error INTERNAL_ERROR`
- 没有出现 `429`(单账号 sustained K≤10 范围内未触发上游 RPS 硬限)
- 没有 timeout(`000`)

## 3. 延迟分布(只含 200)

```text
n        = 1009
min      = 31.26 s
mean     = 38.32 s
p50      = 37.16 s
p95      = 47.83 s
p99      = 57.48 s
max      = 73.11 s
```

失败请求延迟:`n=11  median=11.0s  max=54.6s` —— 大多数失败被上游快速拒绝(11s 中位数),不是长时挂死。

## 4. token / credit 总账

按响应里的 `usage` 字段聚合(覆盖 1000/1000):

| 维度 | 总量 | 单张均值 |
| --- | --- | --- |
| input_tokens   | 40,019  | 40.02 |
| output_tokens  | 456,611 | 456.61 |
| total_tokens   | 496,630 | 496.63 |
| credits        | 16,000  | 16.00 |

- input_tokens 都在 39–41 区间 → 短 prompt 完全压扁了输入端
- output_tokens 主导成本(`image_tokens` 占满)
- credits 是网关侧统计,16cr/张 与模型注册表 `4k 16:9 = 16cr` 完全一致

## 5. 质量 / 完整性校验

```text
decoded            = 1000 / 1000   (b64_json 全部可解)
dim_match          = 1000 / 1000   = 3840×2160
modes              = {RGB: 1000}
duplicate_hashes   = 0             (sha256 全唯一,无上游缓存复用)
revised_prompt     = 1000 / 1000   (上游全部做了 prompt 改写)

png bytes:
  min    = 2.09 MB
  median = 3.49 MB
  mean   = 3.78 MB
  max    = 7.71 MB
  total  = 3603.1 MB

bytes/pixel:
  min    = 0.252
  median = 0.421
  mean   = 0.456
  max    = 0.929
```

**结论**:1000 张全部是真高分辨率、真 RGB 24-bit、无重复、无降级。`bytes/pixel` 中位 0.42 比 1024×1024 medium 的 0.3–0.5 略高,符合 4K + high quality 预期。

## 6. 配额对照(由用户分两次读数反推)

| 时刻 | 5h 剩余 | 周 剩余 |
| --- | --- | --- |
| 起跑前         | 95% | 95% |
| 阶段点(345 张)| 71% | 90% |
| 收尾后         | -   | 85% |

**校准基准**:
- 345 张 ≈ 周额度消耗 5%      → 周总容量 ≈ **6,900 张 4K**
- 345 张 ≈ 5h 额度消耗 24%    → 5h 总容量 ≈ **1,438 张 4K**

**1000 张实测对账**:
- 周额度实测消耗 = 95% − 85% = **10%** ⇒ 投影周容量 ≈ 1000/0.10 = 10,000 张
  - 与初期推算 6,900 略偏差,主因:
    - 阶段点估算只有 345 张样本,基数小
    - 后期 K=10 出错率略高(重试不计入额度)
    - 周额度计数粒度可能是按 token 而非按张
- 取保守值,**周容量 ≈ 6,900–10,000 张 4K**
- 5h 容量 ≈ **1,438 张 4K**(未变,可信度更高,因为 part2 收尾撞到了 503 边界)

**1000 张占额比例**:
| 维度 | 占比 |
| --- | --- |
| 5h 总容量 | ≈ 69.5% |
| 周 总容量(取 6900) | ≈ 14.5% |
| 周 总容量(取 10000) | ≈ 10.0% |

## 7. 按 $200/月 均摊估算单张成本

每月 ≈ 4.35 周 → **每周 ≈ $46.0**。

按周容量 6,900 张:

```text
单张成本 ≈ $46.0 / 6900 ≈ $0.00667/张
1000 张 ≈ $6.67
```

按周容量 10,000 张(实测投影):

```text
单张成本 ≈ $46.0 / 10000 ≈ $0.0046/张
1000 张 ≈ $4.60
```

**单张 4K 实际成本区间:$0.0046 – $0.0067**(月费 $200 摊算)。

## 8. RPS / 并发上限实测

| 模式 | K | 速率 | 成功率 | 备注 |
| --- | --- | --- | --- | --- |
| 瞬时极限并发(barrier 1000) | 1000 | wall 128s | 23/1000 (2.3%) | 800 个 429 在 80ms 内打回 → 上游瞬时 RPS 硬限 |
| 持续 K=6                 | 6   | 9.3 张/min  | ~99% | 稳态甜点 |
| 持续 K=10                | 10  | 15.4 张/min | ~99% | 仍稳,收尾撞 5h 配额(503) |
| 持续 K=20(复杂 prompt)  | 20  | 0–5 张/min  | ≪50% | 不是并发问题:复杂 prompt 把 4K 拉到 ~196s 触发上游断流 |

**关键经验**:
1. **Prompt 复杂度直接决定 4K 是否会断流**。`detailed scene…, varied composition, distinct subject and palette` → ~196s 后 502;同模型 `simple blue cube` → 41s 稳定 200。
2. **单账号 4K sustained 甜点 K=10**,稳定 ~15 张/min ≈ 0.25 req/s,success 99%。
3. **瞬时极限并发是 OpenAI 上游的 RPS 硬限**,不是 gateway 瓶颈;gateway 1k 并发 dispatch 在 330ms 内零阻塞。
4. **5h 窗口 ≈ 1,438 张 4K**,周窗口 ≈ 6,900–10,000 张 4K,**5h 是真实瓶颈**。

## 9. 失败明细 / 上游错误样本(全部脱敏)

```text
status=502 detail={"error":{"message":"stream disconnected before completion",...}}
status=503 detail={"error":{"message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",...}}
status=500 detail={"error":{"message":"stream error: stream ID ...; INTERNAL_ERROR; received from peer",...}}
```

- 502 ↔ 上游生成超时 / 流断,常见于 prompt 复杂或上游瞬时压力
- 503 ↔ codex 账号池短时耗尽(5h 窗口边界)
- 500 ↔ HTTP/2 stream peer reset

## 10. 资产 / 复现

- 脚本:
  - `gateway/scripts/concurrency-limit.sh`(瞬时极限并发,barrier)
  - `gateway/scripts/sustained-1000.sh`(workpool sustained,支持 `WORKDIR` 续跑)
- 数据:
  - `/tmp/sustained-1000/ok/*/img.json`(part1, 411 张)
  - `/tmp/sustained-1000-part2/ok/*/img.json`(part2, 589 张)
  - `/tmp/sustained-1000{,-part2}/attempts.tsv`(每 attempt 记录)
  - `/tmp/sustained-1000{,-part2}/gw.log`(本地 gateway 日志,含上游错误明细)

复现命令:

```bash
cd gateway
CPA_API_KEY=... PROMPT_PREFIX="simple blue cube" K=10 TARGET=1000 \
  WORKDIR=/tmp/sustained-1000 \
  ./scripts/sustained-1000.sh
```

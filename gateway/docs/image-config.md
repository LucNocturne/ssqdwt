# gpt-image-2 网关 · 阶段交付报告

> 报告区间:2026-04 网关从 0 → 1 落地。底层 `gpt-image-2` 经 ChatGPT Pro 账号 + CPA(CLIProxyAPI)反代,网关侧给客户 OpenAI 兼容 API。
>
> 报告口径:**只列已跑通、已实测、已落库的内容**;未测项单独标 GAP。

---

## 一、交付清单

| 类别 | 产物 | 路径 | 状态 |
|:---|:---|:---|:---:|
| 网关服务 | Bun + Hono OpenAI 兼容网关 | `gateway/src/` | ✅ 跑通 |
| 模型矩阵 | 21 个固定规格 + 三轴动态命中 | `gateway/src/models.ts` | ✅ 21 单测全过 |
| 计费 | credits 预扣 + 失败退款,SQLite WAL 原子扣减 | `gateway/src/db.ts` | ✅ 跑通 |
| 鉴权 | API key(sk-img-…)+ admin token | `gateway/src/auth.ts` | ✅ 跑通 |
| 部署 | Dockerfile + Zeabur 配置 | `gateway/Dockerfile` `zeabur.json` | ✅ 已部署 |
| 上游接通 | CPA 经 Pro OAuth 反代 OpenAI | `https://codemo.zeabur.app` | ✅ 跑通 |
| 探针脚本 | size × aspect × quality × format × bg 全维度 | `gateway/scripts/probe-matrix*.sh` | ✅ 已跑 |
| 压测脚本 | 突发并发 / 持续顺序 / 4K 完整性 | `gateway/scripts/capacity-test*.sh` | ✅ Phase 1 已跑 |
| 文档 | 参数矩阵 + 本报告 + v2 plan | `gateway/docs/` `gateway/plans_luc/` | ✅ |

---

## 二、已实现能力

| 能力 | 状态 | 实测证据 |
|:---|:---:|:---|
| 文生图(text→image) | ✅ | 单图 / 批量 / 多比例 / 多清晰度 全部跑通 |
| 多比例支持 | ✅ | 13 种(1:1 / 4:3 / 3:4 / 5:4 / 4:5 / 3:2 / 2:3 / 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21) |
| 多清晰度档 | ✅ | 1K(长边 1024)/ 2K(2048)/ 4K(3840) |
| 多质量档 | ✅ | low / medium / high / auto,Pro 池下 high 真实生效 |
| 真 4K UHD | ✅ | 实测产出 3840×2160 像素文件,长边正好 3840(OpenAI 硬上限) |
| 批量生成 n 参数 | ✅ | n=1..8(单号串行) |
| credits 预扣 + 失败退款 | ✅ | atomic UPDATE WHERE balance ≥ ?,WAL 模式无竞态 |
| 失败重路由 / 退款 | ✅ | 上游 4xx/5xx 全退,recharge_logs 写 reason='refund:<reqId>' |
| OpenAI 兼容签名 | ✅ | `POST /v1/images/generations`,字段对齐 |
| 图生图(image→image) | — | gpt-image-2 上游支持,网关 v2 暴露(详见 v2 plan) |
| 蒙版编辑(mask inpaint) | — | 同上 |
| 透明背景 | ❌ | OpenAI 上游硬拒(invalid_value @ 2 s),与套餐/代理无关 |

---

## 三、实测规格矩阵

> ✅ 实测可生 · ❌ 上游硬拒 · — 短边过小或像素临界,未暴露

| `aspect_ratio` | 1K(长边 1024) | 2K(长边 2048) | 4K(长边 3840) |
|:---:|:---:|:---:|:---:|
| 1:1 | ✅ 1024×1024 | ✅ 2048×2048 | ❌ 像素超 |
| 4:3 / 3:4 | ✅ 1024×768 / 768×1024 | ✅ 2048×1536 / 1536×2048 | ❌ 像素超 |
| 5:4 / 4:5 | — 临界 | ✅ 2048×1638 / 1638×2048 | ❌ 像素超 |
| 3:2 / 2:3 | — 临界 | ✅ 2048×1365 / 1365×2048 | ❌ 像素超 |
| 16:9 / 9:16 | ❌ 过小 | ✅ 2048×1152 / 1152×2048 | ✅ **3840×2160 / 2160×3840** |
| 2:1 / 1:2 | ❌ 过小 | ✅ 2048×1024 / 1024×2048 | ✅ 3840×1920 / 1920×3840 |
| 21:9 / 9:21 | ❌ 过小 | — 短边过小 | ✅ 3840×1646 / 1646×3840 |

**规律**:1K 适合方/近方 · 2K 全适用 · 4K 仅适合宽屏 · 上游长边硬上限 3840 · 像素总量 ≲ 8.3 M。

---

## 四、实测性能数据

### 4.1 单图耗时 / 文件大小

| 用户档位 | 实际尺寸 | 文件大小 | 耗时(中位) | 样本量 |
|:---|:---:|:---:|:---:|:---:|
| 1K low(极速档) | 1024×1024 | ~0.5 MB | ~10 s | 5 |
| 1K medium(`img-standard`) | 1024×1024 | ~1.3 MB | ~22 s | 8 |
| 1K high | 1024×1024 | ~1.5 MB | ~35 s | 5 |
| 2K 16:9 high | 2048×1152 | ~2.5 MB | ~50 s | 4 |
| 2K 1:1 high | 2048×2048 | ~4.0 MB | ~70 s | 4 |
| **4K UHD high(简单 prompt)** | **3840×2160** | ~5–6 MB | **42–46 s** | 5 |
| 4K UHD high(复杂 prompt) | — | — | 502 @ ~67 s | 2/7 失败 |

> 样本量小,**耗时是单点抽样,不作为对外 SLA**。

### 4.2 并发 / 容错

| 指标 | 实测值 | 数据来源 |
|:---|:---|:---|
| 单号上游并发 | 1(CPA Pro 池单号串行) | 代码路径确认 |
| 网关层突发并发承接 | 10 并发请求,180 s 窗口内排队完成 | Phase 1 burst |
| 简单 prompt 成功率 | ~95%+ | smoke + Phase 1 抽样 |
| 复杂 prompt 4K 失败率 | ~30%(Zeabur 边缘 ~60 s 切流) | 4K smoke 7 个样本 2 失 |
| `transparent` 拒绝率 | 100% | OpenAI 上游硬限制 |
| 失败退款链路 | 100% 触发,credits 已退 | usage_logs + recharge_logs 比对 |

---

## 五、计费结构

### 5.1 像素阶梯 → credits

| 像素总量 | credits / image | 覆盖规格 |
|:---|:---:|:---|
| ≤ 1.0 M | **1** | 1K 4:3 / 3:4(0.79 M)、`img-standard`、`img-1k-1024x1024-low` |
| ≤ 2.5 M | **3** | 1K 1:1(1.05 M)、2K 16:9 / 9:16(2.36 M)、2K 2:1 / 1:2(2.10 M) |
| ≤ 5.0 M | **8** | 2K 1:1(4.19 M)、2K 4:3 / 3:4(3.14 M)、2K 5:4 / 4:5(3.35 M)、2K 3:2 / 2:3(2.79 M) |
| ≤ 9.0 M | **16** | 4K 16:9(8.29 M)、4K 2:1(7.37 M)、4K 21:9(6.32 M) |

### 5.2 已确认成本

| 项 | 金额 |
|:---|:---|
| ChatGPT Pro 月费(单号) | $200 / 月 |
| CPA 反代基础设施 | 自建,边际近 0 |
| 网关运行(当前 Zeabur) | $5–20 / 月 |
| OpenAI 单图按 token 另计 | 不适用,Pro 包月覆盖 |

### 5.3 单图成本推算(基于 Pro 包月摊销)

| 假设场景 | 月产能 | 单图成本 |
|:---|:---:|:---:|
| 乐观(单号 3000 张/天) | 90,000 张 | **~$0.0022 / 张** |
| 保守(单号 500 张/天) | 15,000 张 | **~$0.013 / 张** |

> 二者差距来源 = Pro 单号日配额上限,**当前未触发,属 GAP**。

---

## 六、技术边界(已确认)

### 6.1 上游硬限制(无解,与套餐 / 代理 / 网关层无关)

- 长边 ≤ 3840 px
- 总像素 ≲ 8.3 M(3072² 即超预算)
- `background:transparent` 直接拒(invalid_value)
- 无 stream 输出
- 无 seed 字段(无幂等复现)

### 6.2 部署侧已知瓶颈

- **Zeabur 边缘 ~60 s 切流**:4K + 复杂 prompt 触发 502 stream disconnected,概率 ~30%。简单 prompt 不触发。
- **CPA 单号串行**:n>1 等价于顺序执行,n=8 整体耗时 ≈ 8× 单图。

### 6.3 套餐前置

- 必须 ChatGPT **Pro** 池子;Plus 池下 `quality:high` 静默降级到 medium,4K UHD 大概率被拒。

---

## 七、未压测项(GAP)

| # | 待压项 | 影响 |
|:---:|:---|:---|
| 1 | 单号 24 h 滚动产能(找配额上限) | 决定单图成本是 $0.002 还是 $0.013 |
| 2 | 触限错误码 / 文案 / 恢复时间 | 决定客户侧错误处理策略 |
| 3 | 多号水平扩容下吞吐 | 决定能承接 DAU 的上限 |
| 4 | 7 天连续运行稳定性(P99 延迟) | 决定能否对外承诺 SLA |
| 5 | webp / jpeg 输出格式实测体积 | 当前只测 png |
| 6 | Phase 2 / Phase 3 持续压测 | 脚本就绪,执行被截断 |

---

## 八、一句话交付结论

> **网关已在 ChatGPT Pro 池子上跑通文生图全链路:21 个固定规格 + 三轴动态命中 + 真 4K UHD(3840×2160 实测出图)+ credits 预扣 / 失败退款 / OpenAI 兼容签名,客户可立刻按 OpenAI Images API 接入;边界明确(长边 3840 / 像素 8.3 M / transparent 不可用 / Zeabur 边缘 60 s 切流);单图成本上限 $0.013 下限 $0.002,具体落点取决于尚未触发的 Pro 单号日配额——这是下一阶段唯一需要补的硬数字。**

---

### 附录 · 数据来源

- 实测窗口:2026-04-25
- 探针脚本:`gateway/scripts/probe-matrix.sh`、`gateway/scripts/probe-matrix-extended.sh`、`gateway/scripts/smoke-4k-transparent.sh`
- 压测脚本:`gateway/scripts/capacity-test.sh`(Phase 1 已跑)
- 参数矩阵原文:`gateway/docs/model-matrix.md`
- 后续路线:`gateway/plans_luc/v2-images-edits-plan.md`
- 上游路径:客户端 → 网关 → CPA(`https://codemo.zeabur.app`)→ ChatGPT Pro OAuth → OpenAI `gpt-image-2`

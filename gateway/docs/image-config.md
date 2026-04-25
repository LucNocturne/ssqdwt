# gpt-image-2 网关 · image config

> 风格参考 OpenRouter [image generation config](https://openrouter.ai/docs/guides/overview/multimodal/image-generation):前端用 `image_size` (`1K` / `2K` / `4K`) + `aspect_ratio` (`16:9` 等) + `quality` 三轴,底层像素只作映射记录,客户不看到。
>
> 数据来源:CPA(`https://codemo.zeabur.app`)+ ChatGPT Pro 账号,实测窗口 2026-04-25。

---

## 一、模型基础信息

| 字段 | 值 |
|:---|:---|
| `id` | `gpt-image-2-gateway` |
| `name` | gpt-image-2 (via Pro pool) |
| `provider` | OpenAI(经 ChatGPT Pro 账号反代) |
| `upstream_model` | `gpt-image-2` |
| `upstream_proxy` | CPA(CLIProxyAPI),OpenAI 兼容协议 |
| `tier_required` | **ChatGPT Pro**(Plus 不解锁 high 画质) |
| `endpoint` | `POST /v1/images/generations`(OpenAI Images API 兼容) |
| `released` | 2026-04-25 网关首发 |
| `status` | beta — 链路通,产能/成本未压完 |

---

## 二、对外能力说明(modalities & features)

| 能力 | 支持 | 备注 |
|:---|:---:|:---|
| 文生图(text-to-image) | ✅ | 主用法 |
| 图生图(image-to-image) | ⚠️ 上游支持,网关未暴露 | gpt-image-2 原生有 `images/edits`;本网关 v1 只做 `generations` |
| 局部编辑 / inpainting(mask) | ⚠️ 上游支持,网关未暴露 | 同上,需 v2 加 `/v1/images/edits` 路由 |
| 透明背景(transparent) | ❌ | OpenAI 上游硬拒,与套餐/代理无关,见 §九 |
| 批量生成(`n` 参数) | ✅ | n 上限 8;**单号串行**,n 越大整体越慢 |
| 多比例 | ✅ | 13 个比例,不同清晰度档可选集合不同(见 §四) |
| 多清晰度档 | ✅ | `1K` / `2K` / `4K` |
| 多质量档 | ✅ | `low` / `medium` / `high` / `auto` |
| 流式输出(stream) | ❌ | 上游不支持流 |
| seed 复现 | ❌ | OpenAI Images API 无 seed 字段 |

`output_modalities`: `["image"]`
`input_modalities`: `["text"]`(暂未开图生图)

---

## 三、支持参数(image_config schema)

```json
{
  "model": "img-{size}-{w}x{h}",
  "prompt": "string, ≤ 32 KB",
  "n": 1,
  "image_config": {
    "image_size": "1K | 2K | 4K",
    "aspect_ratio": "1:1 | 4:3 | 3:4 | 16:9 | 9:16 | 3:2 | 2:3 | 5:4 | 4:5 | 2:1 | 1:2 | 21:9 | 9:21",
    "quality": "low | medium | high | auto",
    "output_format": "png | webp | jpeg",
    "background": "auto | opaque"
  }
}
```

### 枚举值

| 字段 | 取值 | 默认 | 备注 |
|:---|:---|:---|:---|
| `image_size` | `1K` / `2K` / `4K` | `1K` | 长边 1024 / 2048 / 3840 |
| `aspect_ratio` | 13 种(详见 §四) | `1:1` | 不同 size 下可选集合不同 |
| `quality` | `low` / `medium` / `high` / `auto` | `auto` | Pro 池才解锁 high |
| `output_format` | `png` / `webp` / `jpeg` | `png` | webp 体积最小,jpeg 节流大批量 |
| `background` | `auto` / `opaque` | `auto` | `transparent` **不支持** |
| `n` | 1–8 | 1 | 单号串行执行 |
| `prompt` 长度 | ≤ 32 KB | — | 网关层硬限 |

### 客户端调用模型名

> 网关同时接受**两种入口**(OpenAI 兼容):
>
> 1. **直命名**(预绑定的 21 个 model id,推荐 SDK / 静态 UI):`model: "img-2k-2048x1152"`
> 2. **三轴组合**(image_config,推荐前端动态 UI):`model: "gpt-image-2", image_config: {...}` → 网关解析 → 命中同一规格

---

## 四、规格矩阵(可选集合)

> ✅ = 实测可生 · ❌ = 上游硬拒 · — = 未暴露

| `aspect_ratio` | `image_size: 1K` | `image_size: 2K` | `image_size: 4K` |
|:---:|:---:|:---:|:---:|
| `1:1` | ✅ 1024×1024 | ✅ 2048×2048 | ❌ 像素超 |
| `4:3` / `3:4` | ✅ 1024×768 / 768×1024 | ✅ 2048×1536 / 1536×2048 | ❌ 像素超 |
| `5:4` / `4:5` | — 像素临界 | ✅ 2048×1638 / 1638×2048 | ❌ 像素超 |
| `3:2` / `2:3` | — 像素临界 | ✅ 2048×1365 / 1365×2048 | ❌ 像素超 |
| `16:9` / `9:16` | ❌ 像素过小 | ✅ 2048×1152 / 1152×2048 | ✅ **3840×2160 / 2160×3840** |
| `2:1` / `1:2` | ❌ 像素过小 | ✅ 2048×1024 / 1024×2048 | ✅ 3840×1920 / 1920×3840 |
| `21:9` / `9:21` | ❌ 像素过小 | — 短边过小 | ✅ 3840×1646 / 1646×3840 |

**规律**:**1K 适合方/近方比例**,**4K 仅适合宽屏**,**2K 全适用**。

### 像素 → credits 映射

| 总像素 | credits / image | 覆盖范围 |
|:---|:---:|:---|
| ≤ 1.0 M | **1** | 1K 4:3/3:4(0.79M),img-standard,img-1k-1024x1024-low |
| ≤ 2.5 M | **3** | 1K 1:1(1.05M),2K 16:9 / 9:16(2.36M),2K 2:1 / 1:2(2.10M) |
| ≤ 5.0 M | **8** | 2K 1:1(4.19M),2K 4:3 / 3:4(3.14M),2K 5:4 / 4:5(3.35M),2K 3:2 / 2:3(2.79M) |
| ≤ 9.0 M | **16** | 4K 16:9 / 9:16(8.29M),4K 2:1 / 1:2(7.37M),4K 21:9 / 9:21(6.32M) |

---

## 五、真实输出与验收结论

### 5.1 单图实测样本(Pro 账号 + CPA)

| 用户档位 | 上游 size / quality | 实际返回 | 文件大小 | 平均耗时 | 验收 |
|:---|:---|:---:|:---:|:---:|:---:|
| 1K 1:1 standard | `1024×1024` / medium | 1024×1024 | ~1.3 MB | ~22 s | ✅ |
| 1K 1:1 low(极速) | `1024×1024` / low | 1024×1024 | ~0.5 MB | ~10 s | ✅ |
| 1K 1:1 high | `1024×1024` / high | 1024×1024 | ~1.5 MB | ~35 s | ✅ |
| 2K 16:9 high | `2048×1152` / high | 2048×1152 | ~2.5 MB | ~50 s | ✅ |
| 2K 1:1 high | `2048×2048` / high | 2048×2048 | ~4 MB | ~70 s | ✅ |
| **4K 16:9 high(简单 prompt)** | `3840×2160` / high | **3840×2160** | ~5–6 MB | **42–46 s** | ✅ 真 4K UHD |
| 4K 16:9 high(复杂 prompt) | `3840×2160` / high | — | — | 502 @ ~67 s | ⚠️ Zeabur 边缘超时,见 §九 |
| 1K 1:1 + `background:transparent` | — | — | — | 400 @ ~2 s | ❌ OpenAI 拒(`invalid_value`) |

> 样本量小(每档 3–5 张),**耗时是单点抽样,不是统计分布**。SLA 数字暂不对外承诺。

### 5.2 验收结论

- ✅ **4K 是真 4K**,gpt-image-2 实际产出 3840×2160 像素文件,长边正好 3840(OpenAI 上游硬上限);**不是 2K 套壳**。
- ✅ 网关参数链路对齐:用户档位 → CPA size → 实际像素三档严格一致。
- ✅ Pro 账号下 `quality:high` 真实生效,文件体积和细节明显优于 medium。
- ⚠️ 4K + 复杂 prompt 在 Zeabur 边缘网关 ~60 s 处会被切流(502 stream disconnected);走 VPS / 直连 OpenAI 可解。
- ❌ `transparent` 永久拒,需后处理抠图(rembg / SAM)替代。

---

## 六、并发 / 额度 / 产能

| 指标 | 实测值 | 数据置信度 |
|:---|:---|:---|
| 单号最大并发 | **1**(CPA 池单号串行) | 高(代码路径确认) |
| 已测峰值并发 | 10 并发请求(网关层),实际逐个串行通过 | Phase 1 burst 已跑 |
| 单请求成功率 | ~95%+(简单 prompt) | 中(样本 < 50) |
| 4K 复杂 prompt 失败率 | ~30%(Zeabur 切流) | 中(2/7 失败) |
| 1K 平均产能 | ~2–3 张 / min · 单号 | 推算(22 s/img) |
| 2K 平均产能 | ~1 张 / min · 单号 | 推算 |
| 4K 平均产能 | ~1.3 张 / min · 单号(简单 prompt) | 推算 |
| **单号每日上限** | **GAP — 未触发** | 未测,需挂 24h 持续测 |
| 限流报错形态 | **GAP** | 未触发,无样本 |
| 一天理论产能 / 单号 | 1K ~3000 张 / 4K ~1900 张(无限流前提) | 仅理论,**实际必远低于** |

**已测**:Phase 1(10 并发突发,180 s 窗口)。
**未测 / GAP**:
- Phase 2:300 s 持续顺序产出(脚本就绪,未跑完)
- Phase 3:5–10 张连续 4K 完整性验证(脚本就绪,未跑完)
- 24 小时滚动产能(找单号配额上限)
- 多号横向并行扩容稳定性

---

## 七、成本与定价建议

### 7.1 已知成本

| 项 | 金额 |
|:---|:---|
| ChatGPT Pro 月费 | $200 / 号 / 月 |
| CPA 反代基础设施 | 自建,边际近 0 |
| 网关运行(Zeabur/VPS) | $5–20 / 月 |
| **OpenAI 单图按量计费** | **GAP** — Pro 包月内不另计;走 API key 才按 token 计 |

### 7.2 推算单图成本(基于 Pro 包月摊销)

> 假设单号无限流上限 = 3000 张 / 天(乐观) → 90,000 张 / 月 → **$200 / 90k ≈ $0.0022 / 张**(理论下限)
>
> 实际配额若降到 500 张 / 天(保守) → 15,000 张 / 月 → **$0.013 / 张**

### 7.3 网关定价(credits)

| 用户档位 | credits | 建议售价(参考 OpenAI 官价 50%) | 利润空间 |
|:---|:---:|:---|:---|
| 1K low / standard | 1 | $0.01 / 张 | 高(~$0.008 / 张) |
| 1K high | 3 | $0.025 / 张 | 高 |
| 2K 16:9 / 2:1 | 3 | $0.025 / 张 | 中高 |
| 2K 1:1 / 4:3 / 5:4 / 3:2 | 8 | $0.06 / 张 | 中 |
| 4K UHD / 21:9 / 2:1 | 16 | $0.12 / 张 | 视配额而定 |

> **GAP**:Pro 单号实际日配额未确认 → 利润空间是上限估算,**不能作为对外承诺**。需先跑 24h 配额测才能给商业化数字。

---

## 八、provider 路由说明

```
客户端
  │ POST /v1/images/generations
  │ { model, prompt, n, image_config? }
  ▼
本网关(Bun + Hono,SQLite credits)
  │ 1. apiKey 鉴权 + balance 预扣
  │ 2. model id → ModelSpec(size, quality, output_format)
  │    或 image_config 三轴 → ModelSpec
  │ 3. 透传给 CPA(失败退款,详见 src/db.ts)
  ▼
CPA(CLIProxyAPI,OpenAI 兼容反代)
  │ 4. 用 ChatGPT Pro 账号 OAuth 包装为 Codex 调用
  ▼
OpenAI gpt-image-2(原生)
```

**参数翻译**(网关 → 上游):

| 网关 model id | CPA 请求 size | quality | 备注 |
|:---|:---|:---:|:---|
| `img-standard` | `1024x1024` | medium | 兼容老入口 |
| `img-1k-1024x1024-low` | `1024x1024` | low | 极速档 |
| `img-1k-{w}x{h}` | `{w}x{h}` | high | 1K 高清 3 档比例 |
| `img-2k-{w}x{h}` | `{w}x{h}` | high | 2K 全 11 档比例 |
| `img-4k-{w}x{h}` | `{w}x{h}` | high | 4K 6 档比例(均宽屏) |

**当前所有规格都是真实可用,没有"包装名实际不支持"的情况**(早期 `img-4k-square` 错命名已删除)。

---

## 九、风险与待补测项

### 9.1 已确认风险(产品化前必须处理)

| 风险 | 现状 | 缓解 |
|:---|:---|:---|
| **Pro 单号日配额未知** | OpenAI 不公开,只能压测触发 | 跑 24h 滚动测,挂监控 |
| **Zeabur 边缘 ~60 s 超时** | 4K 复杂 prompt 触发 502 | 迁 VPS / 自建反代,或截断 prompt |
| **transparent 不支持** | OpenAI 硬拒,无解 | 文档明示,服务端 rembg 后处理替代 |
| **依赖 ChatGPT Pro 账号** | 单点故障(封号/降级) | 多号轮转,加 dead-letter 重路由 |
| **CPA 是开源反代,非官方** | TOS 灰区 | 客户合同明示是"代理通道",不打 OpenAI 牌子 |
| **无 seed 复现** | 上游缺字段 | 文档明示,不承诺幂等 |
| **n>1 串行慢** | CPA 单号顺序执行 | 客户端层面建议拆 n=1 并发 |

### 9.2 待补测(影响商业化数字)

- [ ] 单号日配额上限(24h 持续测)
- [ ] 触限错误码 / 文案 / 恢复时间
- [ ] 多号水平扩容下并发吞吐
- [ ] 长时间稳定性(连续运行 7 天 P99 延迟)
- [ ] 不同 prompt 复杂度对耗时的方差
- [ ] webp / jpeg 输出格式实测体积(目前只测了 png)
- [ ] 失败重试策略下的有效成功率
- [ ] OpenAI 直 API 计费对比(若开通官方 Images API,Pro 包月是否仍最优)

### 9.3 不存在的风险(实测排除)

- ✅ **不存在偷偷降清晰度**:用户请求 4K 不会被静默给 2K,要么给真 4K 要么 502,边界清晰。
- ✅ **不存在长队列**:CPA 不排队,要么立刻处理,要么直接 503。
- ✅ **不存在静默失败**:所有失败都会 HTTP 非 200,网关已实现失败退款。

---

## 十、一句话业务结论

> **当前网关已在 Pro 池上跑通 1K / 2K 全比例 + 真 4K UHD 宽屏(3840×2160 实测出图),21 个固定规格 + image_config 三轴动态命中皆可用,失败退款链路打通;但 Pro 单号日配额、长时间稳定性、4K 边缘超时仍是未压死的硬指标 —— 可作为内测 / 小规模灰度上线,不建议直接对外标"无限 4K";对外承诺需在挂 24h 滚动压测 + 迁出 Zeabur 边缘后才能给。**

---

### Sources

- [OpenRouter — Image Generation Config](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [OpenRouter — Multimodal Overview](https://openrouter.ai/docs/guides/overview/multimodal/overview)
- 本仓库:`src/models.ts` / `docs/model-matrix.md` / `scripts/probe-matrix*.sh` / `scripts/capacity-test.sh`

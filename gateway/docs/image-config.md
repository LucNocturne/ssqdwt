<div align="center">

# gpt-image-2 网关 · 阶段交付报告

**报告区间** · 2026-04 · 网关从 0 → 1 落地
**底层链路** · `gpt-image-2` ← OpenAI ← ChatGPT Pro OAuth ← CPA 反代 ← 本网关 ← 客户

</div>

---

## 关键指标速览

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│     21         13         3 档        4K UHD       100%       │
│   固定规格   支持比例    清晰度     真实出图     失败退款     │
│                                                               │
│    3840×2160 px · 长边硬上限 · 总像素 ≲ 8.3 M · OpenAI 兼容   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

| 维度 | 现状 |
|:---|:---|
| **链路** | 客户端 → 网关 → CPA → ChatGPT Pro → OpenAI `gpt-image-2`,**已跑通** |
| **能力** | 文生图 / 多比例 / 多清晰度 / 多质量档 / 批量 / 失败退款,**已上线** |
| **边界** | 长边 3840 / 像素 8.3 M / transparent 不可用 / Zeabur 60 s 切流,**已确认** |
| **单图成本** | $0.0022 ~ $0.013 / 张(取决于 Pro 单号日配额,**未触发**) |

---

## 一 · 交付清单

| 类别 | 产物 | 路径 | 状态 |
|:---|:---|:---|:---:|
| 网关服务 | Bun + Hono OpenAI 兼容网关 | `gateway/src/` | ✅ |
| 模型矩阵 | 21 个固定规格 + 三轴动态命中 | `gateway/src/models.ts` | ✅ |
| 计费引擎 | credits 预扣 + 失败退款,SQLite WAL 原子扣减 | `gateway/src/db.ts` | ✅ |
| 鉴权 | API key(`sk-img-…`)+ admin token | `gateway/src/auth.ts` | ✅ |
| 部署 | Dockerfile + Zeabur 配置 | `gateway/Dockerfile` `zeabur.json` | ✅ |
| 上游接通 | CPA 经 Pro OAuth 反代 OpenAI | `https://codemo.zeabur.app` | ✅ |
| 探针脚本 | size × aspect × quality × format × bg 全维度 | `gateway/scripts/probe-matrix*.sh` | ✅ |
| 压测脚本 | 突发并发 / 持续顺序 / 4K 完整性 | `gateway/scripts/capacity-test*.sh` | ✅ |
| 文档 | 参数矩阵 + 本报告 + v2 plan | `gateway/docs/` `gateway/plans_luc/` | ✅ |

---

## 二 · 链路示意

```
            ┌──────────────┐
            │   客户端     │  OpenAI 兼容 SDK
            └──────┬───────┘
                   │ POST /v1/images/generations
                   ▼
            ┌──────────────┐
            │   本网关     │  Bun + Hono · SQLite credits
            │   (Zeabur)   │  ① auth → ② debit → ③ upstream → ④ refund-on-fail
            └──────┬───────┘
                   │ 透传
                   ▼
            ┌──────────────┐
            │     CPA      │  CLIProxyAPI 反代
            └──────┬───────┘
                   │ Codex OAuth 包装
                   ▼
            ┌──────────────┐
            │ ChatGPT Pro  │  $200 / 月 · 单号串行
            └──────┬───────┘
                   ▼
            ┌──────────────┐
            │ gpt-image-2  │  长边 ≤ 3840 · 像素 ≲ 8.3 M
            └──────────────┘
```

---

## 三 · 已实现能力

| 能力 | 状态 | 实测证据 |
|:---|:---:|:---|
| 文生图(text → image) | ✅ | 单图 / 批量 / 多比例 / 多清晰度 全部跑通 |
| 多比例 | ✅ | 13 种(详见 §四) |
| 多清晰度 | ✅ | 1K · 2K · 4K(长边 1024 / 2048 / 3840) |
| 多质量档 | ✅ | low · medium · high · auto,Pro 池下 high 真实生效 |
| 真 4K UHD | ✅ | 实测产出 3840×2160,长边正好 3840(OpenAI 硬上限) |
| 批量生成 `n` | ✅ | n=1..8(单号串行) |
| credits 预扣 / 退款 | ✅ | atomic UPDATE,WAL 模式无竞态;recharge_logs 写 `reason='refund:<reqId>'` |
| OpenAI 兼容签名 | ✅ | `POST /v1/images/generations`,字段对齐 |
| 图生图 | ✅ | `POST /v1/images/edits`(v2 已上线,multipart) |
| 蒙版编辑 | ✅ | mask PNG 同尺寸校验,网关层守门 |
| 多参考图 | ✅ | `image[]` 最多 10 张 |
| 透明背景 | ❌ | OpenAI 上游硬拒(invalid_value @ 2 s) |

---

## 四 · 规格矩阵 · 实测网格

> **图例** · ✅ 实测可生 · ❌ 上游硬拒 · — 短边过小 / 像素临界,未暴露

|     比例 | **1K** 长边 1024 | **2K** 长边 2048 | **4K** 长边 3840 |
|---------:|:---:|:---:|:---:|
|     1:1 | `1024×1024` ✅ | `2048×2048` ✅ | ❌ |
|  4:3 / 3:4 | `1024×768` / `768×1024` ✅ | `2048×1536` / `1536×2048` ✅ | ❌ |
|  5:4 / 4:5 | — | `2048×1638` / `1638×2048` ✅ | ❌ |
|  3:2 / 2:3 | — | `2048×1365` / `1365×2048` ✅ | ❌ |
| 16:9 / 9:16 | ❌ | `2048×1152` / `1152×2048` ✅ | **`3840×2160` / `2160×3840`** ⭐ |
|  2:1 / 1:2 | ❌ | `2048×1024` / `1024×2048` ✅ | `3840×1920` / `1920×3840` ✅ |
| 21:9 / 9:21 | ❌ | — | `3840×1646` / `1646×3840` ✅ |

**规律** · 1K 适合方/近方 · 2K 全适用 · 4K 仅适合宽屏

---

## 五 · 实测性能

### 5.1 单图耗时 / 文件大小

| 用户档位 | 实际尺寸 | 文件大小 | 耗时(中位) | 样本 |
|:---|:---:|:---:|:---:|:---:|
| 1K low(极速档) | `1024×1024` | ~0.5 MB | ~10 s | 5 |
| 1K medium · `img-standard` | `1024×1024` | ~1.3 MB | ~22 s | 8 |
| 1K high | `1024×1024` | ~1.5 MB | ~35 s | 5 |
| 2K 16:9 high | `2048×1152` | ~2.5 MB | ~50 s | 4 |
| 2K 1:1 high | `2048×2048` | ~4.0 MB | ~70 s | 4 |
| **4K UHD high · 简单 prompt** ⭐ | **`3840×2160`** | ~5–6 MB | **42–46 s** | 5 |
| 4K UHD high · 复杂 prompt | — | — | 502 @ ~67 s | **2/7 失败** |

> 样本量小,**耗时是单点抽样,不作为对外 SLA**

### 5.2 并发 / 容错

| 指标 | 实测值 | 数据来源 |
|:---|:---|:---|
| 单号上游并发 | **1**(CPA Pro 池单号串行) | 代码路径确认 |
| 网关层突发承接 | 10 并发请求,180 s 窗口内排队完成 | Phase 1 burst |
| 简单 prompt 成功率 | **~95%+** | smoke + Phase 1 抽样 |
| 复杂 prompt 4K 失败率 | ~30%(Zeabur 边缘 ~60 s 切流) | 4K smoke 7 样本 2 失 |
| `transparent` 拒绝率 | **100%** | OpenAI 上游硬限制 |
| 失败退款链路 | **100%** 触发,credits 已退 | `usage_logs` ↔ `recharge_logs` 比对 |

---

## 六 · 成本结构 · 资方供应口径

> **业务定位** · 网关 = 给资方做后端供应,资方拿走对外做产品。
> 网关侧 credit 池**对资方实际无限**,credits 只作内部对账 / 用量审计 / 用量分摊,不是 paywall。

### 6.1 像素阶梯 → credits(资方对账系数)

```
   ≤ 1.0 M px  ────►  1  credit    │  1K 4:3 / 3:4 · img-standard · img-1k-1024x1024-low
   ≤ 2.5 M px  ────►  3  credits   │  1K 1:1 · 2K 16:9 / 9:16 · 2K 2:1 / 1:2
   ≤ 5.0 M px  ────►  8  credits   │  2K 1:1 / 4:3 / 5:4 / 3:2
   ≤ 9.0 M px  ────► 16  credits   │  4K 16:9 · 4K 2:1 · 4K 21:9
```

### 6.2 网关侧已确认成本(供应方真账)

| 项 | 金额 | 备注 |
|:---|:---:|:---|
| ChatGPT Pro 月费 · 单号 | **$200 / 月** | Pro 包月覆盖,不另计 token |
| CPA 反代 | $0 | 自建,边际近 0 |
| 网关运行 · Zeabur | $5–20 / 月 | 当前部署 |

### 6.3 单图供应成本推算(Pro 包月摊销)

```
                月产能         单图供应成本
   乐观  ───►  90,000 张  ───► ~$0.0022 / 张
   保守  ───►  15,000 张  ───► ~$0.0130 / 张
```

> 这是**网关交付给资方的真实算力成本**,不是终端售价。
> 资方对其下游的定价由资方自主决定。
> 落点差距来源 = **Pro 单号日配额上限**,当前未触发,属 GAP。

### 6.4 用量数据透传(资方对账接口)

网关把上游 `gpt-image-2` 响应里的 `usage` 字段**原样回传给资方**,便于资方按真实 token 消耗向其下游分摊:

```json
{
  "created": 1714000000,
  "data": [ { "b64_json": "..." } ],
  "usage": {
    "input_tokens": 12,           // prompt 文本 token
    "output_tokens": 4160,         // 生成图像消耗的 image token
    "input_tokens_details": {
      "text_tokens": 12,
      "image_tokens": 0            // edit 模式下输入图被 vision 编码后填充
    },
    "total_tokens": 4172
  }
}
```

同字段同步落 `usage_logs`(`input_tokens` / `output_tokens` / `image_tokens` / `total_tokens` 列),资方可经 admin 接口拉取做账。

---

## 七 · 技术边界 · 已确认

### 上游硬限制 · 无解 · 与套餐 / 代理 / 网关层无关

- 长边 **≤ 3840 px**
- 总像素 **≲ 8.3 M**(3072² 即超预算)
- `background:transparent` **直接拒**(invalid_value)
- 无 stream 输出
- 无 seed 字段 · 无幂等复现

### 部署侧已知瓶颈

- **Zeabur 边缘 ~60 s 切流** · 4K + 复杂 prompt 触发 502 · 概率 ~30% · 简单 prompt 不触发
- **CPA 单号串行** · n>1 等价顺序执行,n=8 整体耗时 ≈ 8× 单图

### 套餐前置

- 必须 ChatGPT **Pro** 池子 · Plus 池下 `quality:high` 静默降级到 medium · 4K UHD 大概率被拒

---

## 八 · 未压测项 · GAP

| # | 待压项 | 影响 |
|:---:|:---|:---|
| 1 | 单号 24 h 滚动产能(找配额上限) | 决定单图成本落点($0.002 vs $0.013) |
| 2 | 触限错误码 / 文案 / 恢复时间 | 决定客户侧错误处理策略 |
| 3 | 多号水平扩容下吞吐 | 决定能承接 DAU 上限 |
| 4 | 7 天连续运行稳定性(P99) | 决定能否对外承诺 SLA |
| 5 | webp / jpeg 实测体积 | 当前只测 png |
| 6 | Phase 2 / Phase 3 持续压测 | 脚本就绪,执行被截断 |

---

<div align="center">

## 九 · 一句话交付结论

</div>

> 网关已在 ChatGPT Pro 池子上跑通**文生图全链路**:
> **21 个固定规格 + 三轴动态命中 + 真 4K UHD(3840×2160 实测出图)+ credits 内部对账 / 失败退款 / OpenAI 兼容签名**,
> 资方可立刻拿走对外按 OpenAI Images API 接入,**网关侧 credit 池对资方无限**;
>
> 边界明确(长边 3840 / 像素 8.3 M / transparent 不可用 / Zeabur 边缘 60 s 切流);
> 单图**供应成本** **上限 $0.013 / 下限 $0.002**,落点取决于尚未触发的 Pro 单号日配额——
> **这是下一阶段唯一需要补的硬数字。**

---

### 附录 · 数据来源

| 类别 | 文件 |
|:---|:---|
| 实测窗口 | 2026-04-25 |
| 探针脚本 | `gateway/scripts/probe-matrix.sh` · `probe-matrix-extended.sh` · `smoke-4k-transparent.sh` |
| 压测脚本 | `gateway/scripts/capacity-test.sh`(Phase 1 已跑) |
| 参数矩阵原文 | `gateway/docs/model-matrix.md` |
| 后续路线 | `gateway/plans_luc/v2-images-edits-plan.md` |

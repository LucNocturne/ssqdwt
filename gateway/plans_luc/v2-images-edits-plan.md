# v2 plan · `/v1/images/edits` 集成(图生图 + inpainting)

> 目标:把 OpenAI 兼容的 `/v1/images/edits` 暴露给客户,覆盖**图生图(image-to-image)**和**蒙版编辑(mask inpainting)**两个能力,gpt-image-2 上游已支持,网关 v1 没接。
>
> 范围:仅网关侧改造;CPA 不动,Pro 账号不动。

---

## 实证结果(2026-04-26 跑通)

> 在写一行代码前先 5 个 curl 探针,**功能已确认可实现**。复现脚本:`gateway/scripts/probe-edits.sh`

| # | 场景 | HTTP | 耗时 | 结论 |
|:---:|:---|:---:|:---:|:---|
| 1 | 单图 + `image` 字段 + `model=gpt-image-1` | 200 | 19 s | i2i 通 |
| 2 | 单图 + `model=gpt-image-2` 别名 | 200 | 17 s | gpt-image-2 是 CPA 端有效别名 |
| 3 | image + mask(同尺寸 PNG alpha) | 200 | 19 s | inpainting 通 |
| 4 | `image[]` × 2 张 multi-ref | 200 | 21 s | 多参考通 |
| 5 | usage 字段完整回传 | ✅ | — | 结构如下 |

**实测 usage 字段结构**(单图 i2i):

```json
{
  "input_tokens": 1074,
  "input_tokens_details": { "image_tokens": 1024, "text_tokens": 50 },
  "output_tokens": 196,
  "output_tokens_details": { "image_tokens": 196, "text_tokens": 0 },
  "total_tokens": 1270
}
```

**关键发现**:
- 输入图固定 **1024 image_tokens / 张**(2 张 → 2048,线性叠加)— 给资方做对账的硬数字
- 输出图 ~196 tokens(1024×1024,medium 档;2K/4K 待补测)
- **CPA 直接透传 multipart**,不需要直连 OpenAI Images API、不需要付费 API key
- 两个 model 名 `gpt-image-1` / `gpt-image-2` 都通,CPA 内部应有别名映射

**直接清掉的疑虑**:
- ❌ "CPA 不透传 multipart" → 实证否定
- ❌ "image vs image[] 字段名歧义" → 两种都通
- ❌ "mask + multi-ref 是未定义行为" → 各自单独通(组合未测,本期不需要)
- ❌ "双轨开发 / 自建直连" → 不需要,单链路 CPA 就行

---

## 关键修订要点(2026-04-26)

> 经多视角对赌 + curl 实证后对原 plan 的两处必改。**范围不变**:i2i + mask + multi-ref 三件套一次性上,vibe coding 一小时级别工作量,无需分 v2 / v2.1。

### ① 链路确认 — CPA 单链路(已实证,无需双轨)

实证(见上节)直接打掉了"CPA 可能不透 multipart"的担心。`upstream.ts` 加一个 `cpaEdit()`(对照 `cpaGenerate()`,只是把 JSON body 换成 FormData)即可,不需要 `openaiEdit()` 直连分支、不需要独立 `OPENAI_API_KEY`、不需要资方批付费账号。

### ② 计费 day-1 引入 multiplier(供应核算系数,**非客户定价锚**)

**背景修正**:网关 = 给资方做后端供应,credit 池对资方无限。multiplier 的作用**不是面向终端客户的价格信号**,而是**网关-资方之间的供应成本核算系数**:edit 比 generation 实际烧上游配额更重,应当在资方账目里反映。**实施成本 = 一行常量**。

**实证锚点**:
- generation 1024×1024 medium 输出 ~196 tokens(已知)
- edit 1024×1024 medium 输入 ~1074 + 输出 ~196 = **总 ~1270 tokens**
- **edit / generation 总 token 比 ≈ 1270 / ~200 ≈ 6.5×**(若上游真按 token 计费;Pro 包月下烧的是配额时间,差异更小)

**day-1 multiplier**:**1.5×**(保守反映"配额烧速差",6.5× 是 token 真账,1.5× 是 Pro 配额视角下的安全系数;链路确认走 CPA/Pro 路径,无 USD/token 真账压力)。

---



---

## 一、目标 & 非目标

**Goals**
1. 暴露 `POST /v1/images/edits`,签名与 OpenAI Images API 兼容(`image` + 可选 `mask` + `prompt`,支持 multi-ref `image[]`)。
2. 复用 v1 的 model 矩阵(`img-{1k|2k|4k}-{w}x{h}`)做尺寸/质量绑定,不引入新参数面。
3. 复用现有 credits 预扣 / 失败退款 / usage_logs 链路,**day-1 引入 edit multiplier 常量**(数字见「关键修订要点 ②」)。
4. 输入图大小 / 格式 / 数量统一限制,防 OOM 和 OpenAI 拒。
5. **probe + 自建 hot path 直连 双轨开发**(见「关键修订要点 ①」),消除 CPA multipart 透传不确定性。
6. **Token usage 透传** — v1 + v2 同步补:从上游响应解析 `usage`(`input_tokens` / `output_tokens` / `input_tokens_details.{text_tokens, image_tokens}` / `total_tokens`),原样在网关响应回传给资方,落库 `usage_logs` 便于资方对其下游做用量分摊与对账。

**Non-Goals**
- 不做 v1 没做的能力:仍不支持 stream / seed / transparent。
- 不引入图床(图片**仅按 multipart 透传**给上游,不落盘)。
- 不做风格化预设(那是产品层,不是网关层)。
- 不做异步任务队列(保持同步 request/response)。

---

## 二、上游 API 调研(gpt-image-2 经 CPA)

### 2.1 OpenAI 官方 `/v1/images/edits` 协议

```
POST /v1/images/edits   Content-Type: multipart/form-data
fields:
  model         = "gpt-image-2"
  prompt        = "文字描述编辑意图"
  image         = file | file[]   (1 张 = 图生图;>1 张 = reference 合成,gpt-image-2 支持最多 ~10 张)
  mask          = file (可选,白色保留/黑色编辑,与 image[0] 同尺寸,PNG with alpha)
  n             = 1..10
  size          = "1024x1024" / "2048x2048" / ...
  quality       = "low|medium|high|auto"
  output_format = "png|webp|jpeg"
  background    = "auto|opaque"      (transparent 仍拒)
  response_format = "b64_json"       (CPA 走这条)
```

**待验证项 / TODO before coding**:
- [ ] 实测 CPA(`https://codemo.zeabur.app/v1/images/edits`)是否完整透传 multipart;若不行需用 base64 字段绕。
- [ ] 实测 multi-image input(`image[]`)在 CPA 是否通。
- [ ] 实测 mask 能否带 alpha 通道传过去。
- [ ] 实测 edit 输出尺寸是否服从 `size` 字段(还是强制 = 输入尺寸)。
- [ ] 实测 edit 模式下耗时分布(理论上比纯生图慢,因为有 vision 输入)。

> 上述四项必须先用 `scripts/probe-edits.sh` 跑通,**否则 plan 不能进入实施**。

### 2.2 调研用 probe 脚本

需要新增 `scripts/probe-edits.sh`:
- 准备一张 1024×1024 PNG(纯色 + 一个圆,prompt 让模型把圆改成方)
- 准备一张同尺寸 mask(只让中心 256×256 区域可编辑)
- 跑 5 个组合:
  1. 单图 image(图生图,无 mask)
  2. 单图 image + mask(局部编辑)
  3. 双图 image[](reference 合成)
  4. 改 size 看输出是否跟随
  5. 故意传 transparent 看 edits 模式下是否仍拒

---

## 三、网关改动点

文件清单(已有 v1 结构):

```
src/
├── index.ts        # +1 路由 /v1/images/edits
├── upstream.ts     # +1 函数 editImage()
├── models.ts       # 加 edit-only 标志 / 像素上限校验(可选)
├── db.ts           # usage_logs 加 op 字段(generation|edit)
├── auth.ts         # 不动
└── admin.ts        # 不动
```

### 3.1 路由层(`src/index.ts`)

```ts
import { editImage, generateImage } from "./upstream.ts";

// multipart 上传专用 bodyLimit,不复用 64KB 那条
app.post(
  "/v1/images/edits",
  bodyLimit({ maxSize: MAX_EDIT_BODY_BYTES }),  // 25 MB
  authMiddleware,                                // 已有
  async (c) => {
    const form = await c.req.parseBody({ all: true });
    // 校验:image (1..10 files) / mask (0..1 file) / prompt / model / n
    // 同 generations 流程:debit → upstream → refund-on-fail → log
  },
);
```

**新增常量**:
- `MAX_EDIT_BODY_BYTES` = 25 MB(默认值,env 可覆盖)
- `MAX_INPUT_IMAGE_BYTES` = 4 MB / 张
- `MAX_INPUT_IMAGES` = 4(初版保守,n 张参考图,后续看实测放宽)
- `ALLOWED_INPUT_MIME` = `image/png` | `image/webp` | `image/jpeg`

**zod schema**:

```ts
const EditMeta = z.object({
  model: z.string().min(1).max(64),
  prompt: z.string().min(1).max(8000)
    .refine(s => Buffer.byteLength(s, "utf8") <= MAX_PROMPT_BYTES),
  n: z.coerce.number().int().min(1).max(8).default(1),
});
```

### 3.2 上游层(`src/upstream.ts`)

新增 `editImage()`,与 `generateImage()` 共享 `UpstreamError` / 超时 / 响应封顶逻辑:

```ts
export async function editImage(
  spec: ModelSpec,
  prompt: string,
  n: number,
  images: File[],
  mask?: File,
): Promise<UpstreamResult> {
  if (UPSTREAM_MODE === "mock") return mockEdit(spec, prompt, n);
  return cpaEdit(spec, prompt, n, images, mask);
}

async function cpaEdit(...) {
  const fd = new FormData();
  fd.append("model", spec.upstream.model);
  fd.append("prompt", prompt);
  fd.append("n", String(n));
  fd.append("size", spec.upstream.size);
  fd.append("quality", spec.upstream.quality);
  fd.append("output_format", spec.upstream.output_format);
  for (const img of images) fd.append("image[]", img);   // 取决于 CPA 实测
  if (mask) fd.append("mask", mask);
}
```

**关键决策**:**不在网关解码图像**(不调 sharp / Image),只做 MIME / 尺寸 / 数量校验,上游 byte-透传 → 风险面最小。

### 3.3 计费

复用 `priceFromPixels(totalPx)` 同一阶梯 → **同 size / quality 下 edit 与 generation 等价计费**。

理由:
- 上游 Pro 池对 edit / generation 同样消耗一次 image token。
- 客户认知简单:同 model id 价格一致。
- 若实测发现 edit 平均耗时 + 失败率明显高于 generation,**v2.1 再加 1.5× edit 倍率**。

### 3.4 数据库

`usage_logs` 表加 `op` 列(`generation` | `edit`)+ token 索引列 + usage 完整 JSON 列:

```sql
ALTER TABLE usage_logs ADD COLUMN op TEXT NOT NULL DEFAULT 'generation';
ALTER TABLE usage_logs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN usage_json TEXT;  -- 完整保留嵌套结构
CREATE INDEX idx_usage_op ON usage_logs(op);
```

`db.ts` 启动时 `PRAGMA user_version` 检测 → 0→1 跑迁移。原有行 `op = 'generation'`,token 列默认 0,`usage_json` 为 NULL。

### 3.5 Token usage 透传(v1 + v2 同步补,实测结构)

**实测上游响应**(单图 i2i / 1024×1024 / medium):

```json
{
  "data": [{ "b64_json": "..." }],
  "background": "auto",
  "output_format": "png",
  "quality": "medium",
  "size": "1024x1024",
  "usage": {
    "input_tokens": 1074,
    "input_tokens_details": { "image_tokens": 1024, "text_tokens": 50 },
    "output_tokens": 196,
    "output_tokens_details": { "image_tokens": 196, "text_tokens": 0 },
    "total_tokens": 1270
  }
}
```

**改动点**:

1. `src/upstream.ts` · `UpstreamResult` 增字段 `usage?: object`(类型 = 上面 JSON 结构原样)
2. `cpaGenerate` / `cpaEdit` 解析上游 JSON 后填 `usage`(若上游缺 `usage`,字段为 `undefined`,不阻断)
3. `src/index.ts` 路由层把 `usage` **原样**写进网关响应 body(嵌套结构保留,资方 SDK 直接读)
4. `src/db.ts` 落 `usage_logs`:**整个 usage 序列化为 `usage_json TEXT` 列**(避免扁平化丢嵌套);同时单独抽出常用字段 `input_tokens` / `output_tokens` / `total_tokens` 做整数索引列,便于聚合查询

**验收**:smoke 跑一次 generation,响应里能拿到 `usage.input_tokens_details.image_tokens` 等嵌套字段;`SELECT json_extract(usage_json, '$.input_tokens_details.image_tokens') FROM usage_logs ORDER BY id DESC LIMIT 1` 非零。

### 3.6 同行对照补强项(2026-04-26 调研)

> 调研 one-api(32.5k)/ new-api / one-hub(2.8k)/ LiteLLM(44.7k)/ Portkey / Helicone / Cloudflare AI Gateway 后,对照本 plan 抽取 **2 项必抄 + 1 项零成本打桩 + 6 项明确不抄**。

#### ✅ 必抄(直接进 v2)

**(A) 尺寸系数计费**(抄 new-api / one-hub) — 替代 §3.3 的固定 `EDIT_MULTIPLIER=1.5`

理由:实证 1k medium edit ≈ 1270 tokens,4k 应线性更高;固定常量无法反映档位差。已有 `models.ts` 矩阵,加一列 `tokenMultiplier` 即可。

落地:`ModelSpec` 增 `tokenMultiplier: number` 字段,`priceFromPixels()` 计算后乘以该系数;1k=1.0 / 2k=4.0 / 4k=8.5(按像素比例,后续以 24h 实测调优)。**~2h。**

**(B) 输入图格式归一化校验**(抄 LiteLLM 思路,精简版) — 防 mask 格式不符上游静默拒

理由:OpenAI `/v1/images/edits` 要求 mask 与 image 同尺寸 PNG with alpha;客户传 JPEG mask 或尺寸错配会被上游 400 拒,网关已扣 credits 后退款,体验差。

落地:在 `cpaEdit()` 透传前读 PNG header 12 字节(IHDR chunk)取宽高,**不解码像素**;若 mask MIME ≠ PNG 或宽高 ≠ image[0],400 拒并不扣 credits。原 §四"不引 sharp"红线保留。**~0.5d。**

#### 🟡 零成本打桩

**(C) `x-request-id` 响应头**(抄 Portkey) — 每个请求生成 UUID,写入响应头 + `usage_logs.request_id` 列,为将来异步任务/客户排查打桩。**~0.1d,顺手做。**

#### ❌ 明确不抄

| feature | 抄者 | 不抄理由 |
|:---|:---|:---|
| 多渠道轮询 / fallback | one-api | 单链路 CPA,架构不匹配 |
| C 端充值 UI / 支付 | chatnio / new-api | 资方供应口径,credit 池无限,无 C 端 |
| b64_json → 托管 URL | one-hub / LiteLLM | 引入存储依赖 + GDPR 风险,违反 §四"不落盘"红线 |
| 流式图像 SSE | 实验性网关 | 上游 gpt-image-2 硬不支持 |
| prompt 模板注入 | one-hub | 侵入客户创作语义,违反网关透明性 |
| 全量请求体落库 | Helicone | base64 体积巨大,与 §四"图像 byte 不入日志"冲突 |

---

## 四、安全与限制

| 项 | 限制 | 实施 |
|:---|:---|:---|
| 总请求 body | ≤ 25 MB | `bodyLimit` 中间件 |
| 单图大小 | ≤ 4 MB | parseBody 后 + file.size 检查 |
| 图片张数 | 1..4 初版 | 计数校验 |
| 图片格式 | png / webp / jpeg | MIME + magic-number 双重校验 |
| 蒙版 | ≤ 4 MB,PNG only | MIME + 头四字节 89 50 4E 47 |
| prompt | ≤ 32 KB,≤ 8000 字符 | 复用 v1 |
| 透传时不落盘 | 内存 → fetch FormData → 释放 | Bun.file 用法 |
| 不重写图像 | 不解码不重新编码 | 不引入图像库 |

**为什么不解码图像验证**:
- 防 OOM 攻击(恶意构造的 PNG decompression bomb);
- 不引入 `sharp` native 依赖,Docker / Zeabur 镜像更小;
- OpenAI 上游会自己拒非法图,网关只挡明显恶意的 size/MIME。

**抗滥用**:对单 key 加 edit 频率上限(初版 30 次 / min),复用 db.ts atomic UPDATE,不引 redis。

---

## 五、验收标准

### 必过
1. `POST /v1/images/edits` 用 `img-1k-1024x1024` + 1 张图 + prompt → 返回 b64_json,size 1024×1024。
2. 同上 + mask → 只 mask 区域被改(肉眼验)。
3. 2 张 reference + prompt → 返回合成图。
4. credits 预扣 / 失败退款 / usage_logs 写入 `op='edit'` 三件齐全。
5. 超过 4 MB 的图 → 413,credits 不扣。
6. 错误格式(svg / gif)→ 400,credits 不扣。
7. 错误 model id → 400,credits 不扣。
8. multipart 缺 image 字段 → 400。
9. Bun 单测 ≥ 12 用例,全过。
10. `scripts/smoke-edits.sh` 跑通(对真 CPA)。

### 性能
- edit 单请求耗时 ≤ generation 同 size 的 **150%**(预期,需实测核)。
- 25 张并发 edit 不 OOM(网关进程 RSS ≤ 512 MB)。

### 风险红线
- ❌ 上传图被持久化任何位置(磁盘 / 缓存 / 日志)。
- ❌ multipart 解析路径有同步 base64 大块阻塞。
- ❌ 出错时图像 byte 出现在 error.detail / 日志(只许记 size + MIME)。

---

## 六、风险

| 风险 | 概率 | 影响 | 缓解 |
|:---|:---:|:---:|:---|
| CPA 不透 multipart | 中 | 高 | 先 probe;若不行改 base64 字段(增 ~33% 流量) |
| edit 模式下 Pro 配额比 generation 快烧 | 中 | 中 | 上线后挂监控;频率限 30/min/key |
| 大图反复触发 Zeabur 边缘 60s 切流 | 高 | 高 | edit 必须迁 VPS,Zeabur 边缘只接 1K |
| OpenAI 对 edit 单独限速(独立桶) | 未知 | 中 | 实测找出 → 出错码透传客户 |
| mask 格式校验过松导致上游拒(占扣 credits 然后退款) | 中 | 低 | 网关层做 magic-number 检查 |
| File API 在 Bun 下行为差异(vs node) | 低 | 中 | 单测覆盖,Docker 镜像锁版本 |

---

## 七、工时估算

| 阶段 | 内容 | 工时 |
|:---|:---|:---:|
| 0. probe | scripts/probe-edits.sh,实测 CPA 5 个场景 | 0.5 d |
| 1. upstream | upstream.ts editImage / cpaEdit / mockEdit + usage 解析 | 0.5 d |
| 2. 路由 + 鉴权 | index.ts /v1/images/edits + bodyLimit + multipart 解析 + `x-request-id`(§3.6 C) | 0.6 d |
| 3. db 迁移 | usage_logs.op + token 列 + usage_json + request_id + PRAGMA user_version | 0.25 d |
| 4. 计费补强 | ModelSpec.tokenMultiplier + priceFromPixels 集成(§3.6 A) | 0.25 d |
| 5. 输入图归一化 | PNG header 解析 + mask 同尺寸校验(§3.6 B) | 0.5 d |
| 6. 单测 | upstream + index 路由 + 计费 + 归一化 ≥ 16 用例 | 0.6 d |
| 7. smoke | scripts/smoke-edits.sh | 0.25 d |
| 8. 文档 | docs/image-config.md §三 把 edit/inpaint 改为 ✅ | 0.25 d |
| **合计** | | **~3.7 d** |

---

## 八、落地顺序(拆 commit)

```
[1] feat(scripts): 新增 probe-edits 探针脚本                           # 阶段 0
[2] feat(upstream): editImage + cpaEdit + mockEdit + usage 解析         # 阶段 1
[3] feat(db): usage_logs 加 op + token + usage_json + request_id 列    # 阶段 3
[4] feat(api): /v1/images/edits 路由 + multipart + x-request-id        # 阶段 2
[5] feat(billing): tokenMultiplier 尺寸系数(§3.6 A)                   # 阶段 4
[6] feat(api): mask PNG header 校验 + 同尺寸守门(§3.6 B)              # 阶段 5
[7] test: edit 路径单测 ≥ 16 用例                                       # 阶段 6
[8] feat(scripts): smoke-edits.sh                                       # 阶段 7
[9] docs: image-config.md / README 更新 edit 能力                       # 阶段 8
```

每 commit 单独跑 `bun test` 必过。
**Gate**:阶段 0 probe 没跑通 → 暂停后续,先解决 CPA 透传问题。

---

## 九、回滚

- v2 全部用新路由 `/v1/images/edits`,**不改** `/v1/images/generations` 任何字节;v1 客户零影响。
- db migration 是加列默认值,无破坏;若 v2 紧急回滚,降版本即可,旧二进制忽略 `op` 列。
- 失败开关:env `IMAGES_EDITS_ENABLED=false` → 路由直接返 503,不动其余链路。

---

## 十、未决问题(需用户拍板)

> 经 probe 实证后剩余的硬决策项:

1. ~~**(Q1)CPA 是否透传 multipart?**~~ — **✅ 已实证通过**(见顶部「实证结果」)
2. ~~**(Q2)直连 OpenAI Images API 用什么认证?**~~ — **作废**,不需要直连
3. **(Q3)edit 烧 Pro 配额是否真比 generation 重?** — token 比 ≈ 6.5×,但 Pro 包月配额视角下差异更小;day-1 取 1.5× 保守安全。**待 24h 滚动配额测后看是否调到 2×**
4. ~~是否在 v2 引入 image-to-image 单独定价?~~ **已裁决:day-1 multiplier=1.5×**
5. 输入图最多几张:**4 张**(OpenAI 上游支持到 ~10 张;实测 2 张已通)
6. 是否需要把 edit 输出和原图一起返还? 推荐:**不返**,客户本地有原图。
7. **Zeabur 是否计划迁 VPS?** 如果不迁,**4K edit 几乎不可用**,可考虑 v2 直接禁 4K edit(只暴露 1K/2K)。

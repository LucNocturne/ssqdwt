# v2 plan · `/v1/images/edits` 集成(图生图 + inpainting)

> 目标:把 OpenAI 兼容的 `/v1/images/edits` 暴露给客户,覆盖**图生图(image-to-image)**和**蒙版编辑(mask inpainting)**两个能力,gpt-image-2 上游已支持,网关 v1 没接。
>
> 范围:仅网关侧改造;CPA 不动,Pro 账号不动。

---

## 关键修订要点(2026-04-26)

> 经多视角对赌后对原 plan 的两处必改。**范围不变**:i2i + mask + multi-ref 三件套一次性上,vibe coding 一小时级别工作量,无需分 v2 / v2.1。

### ① 链路风险前置 — probe + 直连 hot path 双轨开发

不再"先 probe、不通再绕"乐观路径。**根据**:
- `cpaGenerate` 实测用 `application/json` body(见 `src/upstream.ts:78-86`),CPA 主动控 `response_format=b64_json`;**这两点都证明 CPA 不是纯透明代理,而是对 body 做主动封装**。
- `/v1/images/edits` 是 multipart 端点,与 CPA 现有 JSON 协议层不对称,大概率 CPA **不透传 multipart**。

**应对**:`scripts/probe-edits.sh` 与 `src/upstream.ts:openaiEdit()` 同步开发(各 ~10-20 min):
- probe 通 → 走 CPA 路径(零额外依赖)
- probe 不通 → 立刻切 `openaiEdit()` 直连 `https://api.openai.com/v1/images/edits` + 独立 `OPENAI_API_KEY`

**新增未决问题(Q2 → §十)**:Pro 账号 OAuth token 是绑定 ChatGPT session 的,**不能直接当 OpenAI API key 用**,直连必须独立付费 API key,这撕开了 Pro 包月的成本结构 → 见 ②。

### ② 计费 day-1 引入 multiplier(供应核算系数,**非客户定价锚**)

**背景修正**:网关 = 给资方做后端供应,credit 池对资方无限。multiplier 的作用**不是面向终端客户的价格信号**,而是**网关-资方之间的供应成本核算系数**:edit 比 generation 实际烧上游配额更重(多吃 vision encoder),应当在资方账目里反映为更高的供应单价。**实施成本 = 一行常量**,不影响范围。

**倍率取决于 ① 的链路结果**:

| 链路 | 上游真实成本 | 供应核算 multiplier | 备注 |
|:---|:---|:---:|:---|
| CPA + Pro 包月($200/月封顶) | edit 烧 Pro 配额 ≈ generation × 1.5 | **1.5×** | Pro 配额内边际成本接近零;1.5× 反映"配额烧速差"信号,供资方-供应方核算用 |
| 直连 OpenAI Images API + 付费 key | edit 真实 USD/token,~$0.04/张 | **5-10×** | Pro 包月成本失效,必须按真实 token 价覆盖,这是资方供应费的真正下限 |

**单 multiplier 常量,链路裁决后即填**。资方对其下游的对外定价不受此约束。

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

`usage_logs` 表加 `op` 列(`generation` | `edit`)+ token 列(给资方下游对账用):

```sql
ALTER TABLE usage_logs ADD COLUMN op TEXT NOT NULL DEFAULT 'generation';
ALTER TABLE usage_logs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN image_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_logs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_usage_op ON usage_logs(op);
```

`db.ts` 启动时 `PRAGMA user_version` 检测 → 0→1 跑迁移。原有行 `op = 'generation'`,token 列默认 0。

### 3.5 Token usage 透传(v1 + v2 同步补)

**上游响应字段**(gpt-image-2 实际返回结构):

```json
{
  "data": [{ "b64_json": "..." }],
  "usage": {
    "input_tokens": 12,
    "output_tokens": 4160,
    "input_tokens_details": {
      "text_tokens": 12,
      "image_tokens": 0
    },
    "total_tokens": 4172
  }
}
```

**改动点**:

1. `src/upstream.ts` · `UpstreamResult` 增字段 `usage?: { input_tokens, output_tokens, image_tokens, total_tokens }`
2. `cpaGenerate` / `cpaEdit` / `openaiEdit` 解析上游 JSON 后填 `usage`(若上游缺 `usage`,字段全 0,不阻断)
3. `src/index.ts` 路由层把 `usage` 原样写进网关响应 body(OpenAI 兼容,资方 SDK 直接读)
4. `src/db.ts` 写 `usage_logs` 时把 token 字段一并落库(供后续对账查询)

**验收**:smoke 跑一次 generation,响应里能拿到 `usage.input_tokens` 等字段;`SELECT input_tokens FROM usage_logs ORDER BY id DESC LIMIT 1` 非零。

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
| 1. upstream | upstream.ts editImage / cpaEdit / mockEdit | 0.5 d |
| 2. 路由 + 鉴权 | index.ts /v1/images/edits + bodyLimit + multipart 解析 | 0.5 d |
| 3. db 迁移 | usage_logs.op 列 + PRAGMA user_version 启动迁移 | 0.25 d |
| 4. 单测 | upstream + index 路由 ≥ 12 用例 | 0.5 d |
| 5. smoke | scripts/smoke-edits.sh,文档更新 | 0.25 d |
| 6. 文档 | docs/image-config.md §二 把 edit/inpaint 改为 ✅ | 0.25 d |
| **合计** | | **~2.75 d** |

---

## 八、落地顺序(拆 commit)

```
[1] feat(scripts): 新增 probe-edits 探针脚本                           # 阶段 0
[2] feat(upstream): editImage + cpaEdit + mockEdit                      # 阶段 1
[3] feat(db): usage_logs 加 op 列 + 迁移                                # 阶段 3
[4] feat(api): /v1/images/edits 路由 + multipart 校验                   # 阶段 2
[5] test: edit 路径单测 ≥ 12 用例                                       # 阶段 4
[6] feat(scripts): smoke-edits.sh                                       # 阶段 5
[7] docs: image-config.md / README 更新 edit 能力                       # 阶段 6
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

> 硬决策项:

1. **(Q1)CPA 是否透传 multipart?** — probe day-0 必跑,影响整条链路。
2. **(Q2)若 CPA 不透传,直连 OpenAI Images API 用什么认证?**
   - Pro OAuth token 不能直接当 API key([L3] 推断,待实测核)
   - → **大概率必须独立付费 OPENAI_API_KEY**,Pro 包月成本结构失效,改按真实 token 计费
   - **资方需准备 OpenAI 付费账号 + 预算上限**
3. **(Q3)edit 烧 Pro 配额是否真比 generation 重?** — 决定 CPA 路径下 multiplier 数字(1.2× / 1.5× / 2×)
4. ~~是否在 v2 引入 image-to-image 单独定价?~~ **已裁决:day-1 引入 multiplier 常量**(见「关键修订要点 ②」)
5. 输入图最多几张:**4 张**(OpenAI 上游支持到 ~10 张)
6. 是否需要把 edit 输出和原图一起返还? 推荐:**不返**,客户本地有原图。
7. **Zeabur 是否计划迁 VPS?** 如果不迁,**4K edit 几乎不可用**,可考虑 v2 直接禁 4K edit(只暴露 1K/2K)。

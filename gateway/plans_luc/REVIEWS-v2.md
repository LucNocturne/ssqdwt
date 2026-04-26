# REVIEWS · v2 image edits plan

> 评审窗口: 2026-04-26T12:26:35+08:00
> 被评审文件: gateway/plans_luc/v2-images-edits-plan.md
> 评审者: Claude CLI (独立 session, sonnet)

---

# 评审结论

## 1. 致命缺陷 (blocker)

**B1. "直连 OpenAI" 不是 CPA 的等价 fallback,而是完全不同的供应链**
plan §关键修订 ① 把 probe 失败的退路写成 "切 `openaiEdit()` 直连 `https://api.openai.com/v1/images/edits` + 独立 OPENAI_API_KEY",并在 §十 Q2 含糊表述为"大概率必须独立付费 key"。事实是:Pro OAuth 是 `chatgpt.com/backend-api` 的 session token,host 都不一样,**100% 不能用于 `api.openai.com`**,不存在"大概率"。这意味着所谓"双轨"实际是两条独立供应链(Pro 包月 vs 真实 USD/token),成本结构、退款语义、SLA 全部不同。应改为:probe 不通 → **停下来跟资方谈付费账号 + 预算 + 单独 multiplier 单独跑账**,不能把它当"另一条 hot path"在同一个 commit 里上线。

**B2. mask + multi-ref 一次性交付存在协议层未定义行为**
plan §2.1 协议表写 "image = file | file[]" 与 "mask 与 image[0] 同尺寸",§3.2 代码 `for (const img of images) fd.append("image[]", img);` 单图也走 `image[]`。问题:(a) OpenAI gpt-image-1 单图模式字段名是 `image`,数组模式才是 `image[]`,**混用会被部分 multipart parser 当成单元素数组,部分当 400**;(b) mask + multi-ref 组合在 OpenAI 官方文档里**未定义行为**(mask 语义绑死 image[0],多图时上游可能直接拒)。§7 验收标准把 "2 张 reference + prompt → 返回合成图" 与 "单图 + mask → 局部编辑" 都列必过,但**两者同时走通**没有验收。建议:probe 阶段必须分别测 `image` 和 `image[]` 两种字段名,并且明确 plan 不承诺 mask + 多 ref 共用。

**B3. probe 通过条件不构成可发布判据**
plan §二 §2.2 列 5 个 probe 场景,§八 Gate 只说 "probe 没跑通 → 暂停"。**没有定义"跑通"的判据**:5 个全过?核心 3 个过?CPA 返回 200 但 usage 字段缺失算过吗?输出尺寸不跟随 size 算过吗?这直接决定 §3.5 usage 透传能不能落库,也决定 multiplier 数字。**不锁判据,probe 就是走过场**。

## 2. 重要风险 (P1)

**P1.1 usage 字段结构假设与库表设计有错位**
§3.4 把 `image_tokens` 拍平成一列,§3.5 上游响应示例里 `image_tokens` 嵌套在 `input_tokens_details` 下,**只代表"输入图像 token"**;gpt-image-1 输出 token 也会算钱但全归到 `output_tokens`(图像生成 token)。落库丢掉这层结构,后续资方做"输入 vs 输出图 token 分账"无法回算,只能重跑日志。建议:要么落 `input_image_tokens` / `output_image_tokens` 两列,要么直接 `usage_json TEXT` 整体存。

**P1.2 multiplier 不落库,链路切换后历史不可对账**
"单 multiplier 常量" 写死在代码里,但 plan 同时承认 CPA 路径(1.5×)和直连路径(5–10×)同表共存。usage_logs 没有 `path` / `unit_price` / `multiplier` 列,**链路切换那一刻起,历史记录里"扣了多少 credit"无法反推用了哪条供应链**,资方对账会撕。建议:`usage_logs` 加 `supply_path TEXT` + `multiplier REAL` 两列,与 op 列同一次迁移落地。

**P1.3 n>1 计费语义未定**
§3.3 只说"复用 priceFromPixels(totalPx) 阶梯",§3.1 zod 允许 `n ≤ 8`。**n=4 时是 1× 还是 4× edit_multiplier?** plan 全文没回答。OpenAI 上游 n>1 实际是跑 n 次,token 也是 n 倍。漏写会导致预扣不够、退款逻辑歪掉。

**P1.4 25 张并发 RSS ≤ 512 MB 估算偏乐观**
§5 性能红线和 §4 限制冲突:单请求 body 25MB × 25 并发 = 625MB raw body,加上 Hono `parseBody({all:true})` 把所有 File 在内存里展开、上游 fetch 又复制一份成 multipart wire bytes,峰值可达 1.2–1.8GB。Zeabur 容器实例若 512MB cap **直接 OOM**。先把 "≤ 512MB" 改成"按实际容器规格定" 或把并发上限做 semaphore。

**P1.5 60s 边缘超时与 edit 大图直接撞车**
§六 风险表已列 "Zeabur 边缘 60s 切流 → edit 必须迁 VPS",但 §一 Goals 没把"迁 VPS / 禁 4K edit"列为前置条件。现有上下文里 UHD generation 已经多次 67s 502。**edit 比 generation 慢(plan 自己估 150%),4K edit 几乎注定 502**。Q7 把"是否禁 4K edit"留作未决,这是发布阻塞项不是 nice-to-have。

## 3. 次要建议 (P2)

- **P2.1** §四 magic-number 只列了 PNG 四字节,WebP (`RIFF....WEBP`,需要看 offset 8) 和 JPEG (`FF D8 FF`) 没列,实施时容易写漏。
- **P2.2** §3.5 "usage 字段全 0,不阻断" 应改为"usage 字段缺失记 NULL",0 和"上游真返回 0" 会混淆。
- **P2.3** §九 回滚开关 `IMAGES_EDITS_ENABLED=false` 仅返 503,但若 multipart 解析路径 panic 会污染整个 Hono worker,光开关不够,应在路由注册阶段就用条件挂载。
- **P2.4** §3.2 不解码图像直接透传是好决策,但缺一条:**禁止把图像 byte 进任何 logger / error.detail**,§5 风险红线虽然提了,代码层应在 UpstreamError 构造里硬编码屏蔽 fd 字段。
- **P2.5** edit 频率上限"30 次/min/key"无依据,可以先不限,等 §六 风险监控数据出来再加。

## 4. 维度专项

**probe + 直连双轨 1 小时落地** — 不可能。`openaiEdit()` 直连不是"换个 URL":要新增 env 加载、独立 timeout/重试、独立 usage 解析(付费 API 与 CPA 返回字段不一定 1:1)、独立计费分支、独立 mock。诚实估时:probe 30min + cpaEdit 路径 60–90min + openaiEdit 路径 60min(若真启用还要付费账号 setup),**起步 3 小时,且这是在 B1 解决之后**。

**FormData in Bun** — Bun 原生支持 Web 标准 FormData/File,`fetch(url, {body: fd})` 自动 multipart,无需手设 boundary。但两个坑:(a) Hono `c.req.parseBody({all:true})` 拿到的 `File` 直接 append 进 FormData 转发是 OK 的,但**字段名带 `[]` 时 Hono 会自动把 value 包成数组**,代码里要用 `body['image[]']` 取数组,不是 `body.image`;(b) Bun ≤1.1.x 在某些版本对 File.stream() 转发存在已知 bug,保险起见 plan 应锁 Bun 版本(§六风险表只说"锁版本"没说锁哪个)。

**usage 字段假设** — 字段名(input_tokens / output_tokens / input_tokens_details.{text_tokens,image_tokens} / total_tokens)与 OpenAI gpt-image-1 公开响应**结构对齐**,这部分 plan 没错。但有两个隐患:(a) **CPA 中间层是否透传 usage 未验证**,plan §2.2 probe 5 项没把"usage 字段是否存在且非空"列为必测,这是漏项;(b) 直连付费 API 时 `usage` 一定有,CPA 路径可能没有,造成同一个网关响应里 usage 字段时有时无,资方 SDK 适配负担。

**Pro OAuth vs 付费 API key** — 见 B1。补一条:CPA 上游显然是 Pro OAuth → ChatGPT backend 协议转换,网关现在感知不到这一层,如果 CPA 哪天改协议(如改成 Sora 走的另一套 endpoint),网关 probe 一过就上线、出事时根本不知道是 CPA 改了还是 OpenAI 改了。建议网关在响应里加内部字段 `_supply_path: "cpa" | "openai"`(仅 admin 模式可见),便于事后归因。

**multiplier 落库** — 见 P1.2。补充:资方"对其下游做用量分摊与对账"是 §3.5 自己写的目标,不落 multiplier 这条目标完不成。**必须落库**,而且建议同时落 `unit_price_credits`(那一刻的实际单价),不要只落系数,系数会变价格也会变。

**mask + multi-ref 协议雷区** — 见 B2。再补:OpenAI multipart 解析对"同名多次 append" vs "name[] 后缀" 的接受度,不同年份的 SDK 表现不同,**只有真打到 OpenAI 才能确定**,而 plan 假设 CPA 行为 = OpenAI 行为,这个等价没人验证过。

## 5. 被忽略的事实 (blind spot)

- **B5.1** plan 全程没提 "edit 输出 b64_json 大小":2048×2048 PNG b64 在 5–10MB,n=4 时单个响应 20–40MB,Hono response 无 chunked 时整块进内存,叠加 §3.4 落 usage_logs 的同步写,慢请求会卡 event loop。
- **B5.2** 退款语义在 67s 流断场景未定义:Pro 配额已扣但网关收到的是 stream-disconnect → 退 credit 是对的,但 Pro 那边不退,**资方账面 credit ≠ 上游真实成本**,multiplier 1.5× 假设里没把这种"扣了不退"的损耗算进去。
- **B5.3** §九 db migration "PRAGMA user_version 0→1" 单向,没写降级路径(回滚到 v1 时 v2 已经写过 op='edit' 的行,v1 二进制虽然忽略 op 列但**总扣费金额会少算**,因为 v1 没有 multiplier 概念)。
- **B5.4** plan 默认网关日志层不会泄露图像 byte,但 §6 工时里没有"日志审计"任务,实际 Hono error handler 默认会 dump req body。
- **B5.5** OpenAI gpt-image-1 真实模型名是 `gpt-image-1`,plan 全文写 `gpt-image-2`。如果是项目内部别名要在 §2.1 注明映射;如果是 typo,probe 脚本会直接 400 model_not_found。
- **B5.6** edit 与 generation 并发共用同一 token bucket,plan 没说 rate limit 是否独立,30/min/key edit limit 与 generation limit 是叠加还是互斥未定。

## 6. 一句话结论

**范围裁剪是对的,但"双轨 1 小时落地"严重低估了 B1 的供应链分叉成本与 B2 的协议未定义行为,multiplier/path 不落库会让链路切换那天起所有历史无法对账;在 B1/B2/B3 三个 blocker 解决前不要进入实施阶段。**

# gateway — 已知问题与延后项

## 来源
- Codex 审查(2026-04-25, P1/P2 已修, P3 暂不阻断 demo)
- Codex 5 路并行审查(2026-04-26, v2 /v1/images/edits 实现后,5 commit f40d79e..fab21ba)

---

## v2 审查 · 2026-04-26 · 5 路并行

> 5 个 Codex 各盯一个维度独立审查,按严重度排序。

### 🔴 P1 阻断项

#### 1. bodyLimit bypass + auth 顺序不当
- 位置:`gateway/src/index.ts:33` / `:50` / `:243`
- 现象:全局 64KB gate 对 exact path 直接 `next()`,但 25MB gate 挂在 `POST /v1/images/edits` 路由上且位于 `authMiddleware` **之后**。结果:
  - 未鉴权 `POST /v1/images/edits` 返回 401 而非 413(body 已被吃)
  - 已鉴权 `PUT /v1/images/edits` 返回 404,完全没有 body limit
- 修复:不要按 exact path bypass,在全局中按 `method+path` 选 25MB 或 64KB,或把 edits 的 limit 挪到 auth 之前。

#### 2. MIME 白名单可绕过 → 任意上传
- 位置:`gateway/src/index.ts:306` / `:329` / `:335`
- 现象:MIME 白名单完全信任 multipart part 的 `Content-Type`,PNG "校验"只看前 24 字节。本地复现:伪造 `image/jpeg` 的 SVG/HTML、带假 PNG 头的任意 payload 都通过校验返回 200。
- 修复:服务端做 magic-byte 真校验,不信任客户端 Content-Type,PNG 不仅信任 IHDR 头。

#### 3. 扣费/退款不在同一事务 → 崩溃窗口产生孤儿账
- 位置:`gateway/src/index.ts:124` / `:150` / `:170` / `:430` / `:457` / `:477`
- 现象:`debit → upstream → refund → usage_log` 是分步的。进程在"已扣费但未记账/未退款"窗口崩溃 → 余额错账 + 漏审计。
- 修复:debit + 写 pending 记录放同一事务;成功/失败用第二个事务原子更新状态;启动时补偿 stale pending。

#### 4. CPA 错误原文持久化 → 凭据/内部路径泄漏
- 位置:`gateway/src/upstream.ts:153` / `:239`,`gateway/src/index.ts:185`,`gateway/src/db.ts:184`
- 现象:`cpaGenerate/cpaEdit` 把上游错误原文塞进 `UpstreamError.detail`,后面原样写日志和 `usage_logs.error`。代码不主动打 header,但若 CPA/反代回显请求头,`Authorization: Bearer ...`、内部路径、版本号会被持久化。
- 修复:错误进入日志前统一脱敏 `authorization|bearer|api[-_]key`,默认不落 upstream 原始 body。

#### 5. cpaEdit 单图也发 image[] → 切 CPA 模式直接 400
- 位置:`gateway/src/upstream.ts:218`
- 现象:`cpaEdit` 对所有输入硬编码 `image[]`,但仓库自己的 CPA probe 单图场景发的是 `image`。最常见的单图 edit 路径切到 `UPSTREAM_MODE=cpa` 后大概率直接 400。
- 修复:`images.length === 1` 用 `image`,多图才用 `image[]`,补真实 CPA 集成测试。

#### 6. 退款路径 0 回归测试
- 位置:`gateway/src/index.ts:477`
- 现象:`debit 成功 → upstream 失败 → refund` 分支没有任何回归测试,现有用例无前后 `credits_balance` 一致性断言。
- 修复:注入必失败的 `editImage` stub,断言请求前后余额相等,且只新增一条 `refund:<requestId>` 记录。

### 🟡 P2

#### 7. mask 同尺寸校验仅对 PNG 输入生效
- 位置:`gateway/src/index.ts:345`
- 现象:mask 尺寸比对只在 `image[0].type === "image/png"` 时执行,jpeg/webp 输入跳过;`image/jpeg` + 1×1 PNG mask 返回 200。
- 修复:为 jpeg/webp 解析真实尺寸,或带 mask 时强制 image[0] 必须是真实 PNG。

#### 8. recharge_logs 不是结构化 ledger
- 位置:`gateway/src/db.ts:36` / `:140` / `:148`
- 现象:debit 不记结构化流水,refund 只靠 `reason="refund:${requestId}"` 文本约定关联,对账和幂等保护脆弱。
- 修复:debit/refund 统一进 ledger,落 `request_id, op, amount, status`,加 `(request_id, op)` 唯一约束。

#### 9. edit 计价忽略 mask 与 image 数量
- 位置:`gateway/src/models.ts:184`,`gateway/src/index.ts:320` / `:427`
- 现象:`/v1/images/edits` 只看 `spec` + `n`,可选 mask 与最多 4 张 image[] 输入不影响价格,高成本编辑被系统性低估。
- 修复:把 `hasMask` / `imageCount` 纳入 `calculateEditCost` 签名和定价表。

#### 10. /v1/usage 汇总不按 op 分桶
- 位置:`gateway/src/db.ts:209`
- 现象:`usage_logs` 已加 op 列,但 `/v1/usage` 仍只按 `(model, status)` 聚合,edits 与 generations 混在一起。
- 修复:`SELECT/GROUP BY` 加 op,管理端导出按 op 分桶。

#### 11. user_version 迁移并发竞态
- 位置:`gateway/src/db.ts:47`
- 现象:`PRAGMA user_version` 在事务外读取,双实例并发启动可能都看到 0,后启动方再次 ALTER 因列重复直接启动失败。
- 修复:把"读 user_version + 判定 + DDL"放进 `BEGIN IMMEDIATE` 事务,或事务内用 `PRAGMA table_info` 做幂等检查。

#### 12. 内存放大:全 multipart 物化 + 多份 buffer
- 位置:`gateway/src/index.ts:262` / `:335` / `:346`,`gateway/src/upstream.ts:211`
- 现象:先 `parseBody({ all: true })` 吃完整个 multipart → 再为读 24B PNG 头对 mask/image[0] 调 `arrayBuffer()` → 最后重组 FormData 发 CPA。4MB×4 请求出现多份内存副本。
- 修复:避免全量 parseBody / 整文件 arrayBuffer,header-only 读或临时落盘流式转发,edit 并发设上限。

#### 13. usage 字段无运行时 schema 校验
- 位置:`gateway/src/upstream.ts:182` / `:268`,`gateway/src/index.ts:165`,`gateway/src/db.ts:199`
- 现象:CPA 返回的 usage 直接透传 + 落库,缺字段被吞成 0,字符串/NaN/Infinity 直接写进响应和 `usage_json`。
- 修复:upstream 边界用 schema 校验 + finite-number 归一化,非法字段丢弃或置空。

#### 14. insufficient credits 测试只验状态码
- 位置:`gateway/src/edits.route.test.ts:239`
- 现象:402 测试没断言"未扣款、未退款、余额不变";资金路径回归无法被测出。
- 修复:补前后 `findKeyById(id).credits_balance` 比对 + `recharge_logs` 没新增 refund 记录的断言。

#### 15. 业务校验失败不锁资金不变式
- 位置:`gateway/src/edits.route.test.ts:126` / `:189`
- 现象:`mask size mismatch` / `image[] > 4` 只测 400,没锁住"校验失败发生在 debit 之前"。
- 修复:补余额、`usage_logs`、`recharge_logs` 前后计数断言。

#### 16. 0 并发覆盖
- 位置:`gateway/src/index.ts:429`
- 现象:不存在"10 个 key 同时打 edits"的测试,WAL 下并发原子性靠脑补。
- 修复:加 `Promise.all` 并发集成测试,断言响应分布 + 余额守恒。

#### 17. readPngDims 畸形 PNG 0 测试
- 位置:`gateway/src/index.ts:220`
- 现象:截断 header / 错误 magic / 伪造巨大 IHDR 全没测。
- 修复:表驱动测试集,坏 mask PNG 统一断言 400 + 错误消息。

#### 18. mockEdit token 弱断言
- 位置:`gateway/src/upstream.test.ts:34`
- 现象:`image_tokens` 写死 1024,测试只 `>= 1024`,token 求和回归不会被发现。
- 修复:精确断言 `input_tokens === text_tokens + image_tokens`,补 2 张图 case。

#### 19. IMAGES_EDITS_ENABLED=false placeholder 测试
- 位置:`gateway/src/edits.route.test.ts:217`
- 现象:13 行 placeholder,根本没走到 503 分支。
- 修复:独立模块实例下重导入 app,真断言 503/service_unavailable。

#### 20. smoke-edits.sh "大图 4MB" 前提是假的
- 位置:`gateway/scripts/smoke-edits.sh:33`
- 现象:脚本生成的 `4000×4000` 白底 PNG 实际只有 ~56KB(高度可压缩),`t6` 打不到 413。
- 修复:生成不可压缩随机像素图,或先校验文件大小再发请求。

### 🟢 P3

#### 21. per-image / image[] 上限在 parseBody 之后才 reject
- 位置:`gateway/src/index.ts:262` / `:288` / `:300`
- 现象:`MAX_INPUT_IMAGE_BYTES=4MB` 与 `MAX_INPUT_IMAGES=4` 在 `parseBody({ all: true })` 之后才检查,内存已被吃完才 reject。
- 修复:流式 multipart 解析,part 级别限长 / 数量,或反代层做。

#### 22. CREATE INDEX 启动时同步执行
- 位置:`gateway/src/db.ts:55`
- 现象:`CREATE INDEX idx_usage_op` 放在启动迁移里,大表会全表扫描持有写锁,WAL 下另一 writer 易超 5s busy_timeout。
- 修复:索引拆独立运维迁移 / 低峰单实例步骤。

#### 23. 退款路径假设 key 存在
- 位置:`gateway/src/db.ts:148`,`gateway/src/admin.ts:73`
- 现象:若后续加删除能力或库外删除,`UPDATE` 0 行后再 INSERT recharge_logs 触 FK 异常,把上游失败掩盖成 500。
- 修复:检查 UPDATE changes,key 不存在做幂等可恢复分支。

#### 24. mockEdit 全是魔数
- 位置:`gateway/src/upstream.ts:70` / `:92` / `:106`
- 现象:`mockEdit` 完全忽略真实输入图数量/尺寸/mask,固定 `image_tokens=1024`、`output_tokens=196*n`。
- 修复:mock 不返回 usage,或按 `images.length + spec.upstream.size` 生成估算值并打 estimate 标记。

#### 25. smoke-edits.sh 不会失败 + 不在 CI
- 位置:`gateway/scripts/smoke-edits.sh:40`,`gateway/package.json:10`
- 现象:脚本只打印 HTTP/摘要,期望不符不退非 0;仓库无 CI 或 test 入口引用。
- 修复:HTTP/body 不匹配时 `exit 1`,接 CI 或独立 npm script。

#### 26. v1 generations 回归断言过弱
- 位置:`gateway/src/edits.route.test.ts:223`
- 现象:`bun test` 当前 58/58 全绿,但 v1 generations 回归面只剩"200 + usage.input_tokens > 0"一条弱断言。
- 修复:拆独立 generations 回归测试,断言响应 usage + `usage_logs.{op,input_tokens,output_tokens,usage_json}`。

---

## 既有 P3 加固清单(量产前,来自 2026-04-25 baseline)

### 速率限制
- 网关无 per-key / per-IP 限流。生产前接 `hono/rate-limiter` 或反代层。
- 风险:单 key 可打满 CPA 配额、触发上游风控。

### 访问日志
- 当前只在错误路径打 log。正常请求无 access log,出问题不可回溯。
- 建议:加 structured access log(JSON,带 requestId、key_id、model、status、latency)。

### SQLite 备份
- WAL 模式下 `cp gateway.db` 不安全。
- 建议:用 `VACUUM INTO` 或 litestream 做实时备份。

### CORS / CSRF
- 当前默认无 CORS。如未来要做管理 UI 走浏览器,需明确 allowlist。

### `seed.ts` / `loadtest.ts` 安全
- 脚本不会被 `bun start` 触发(✅),但 README 应明确"勿在生产 run loadtest"。

### CPA `Authorization` 日志脱敏
- 当前不打 CPA 请求日志。后续若加 access log,需主动脱敏 `Authorization` header。

### 部署期权限

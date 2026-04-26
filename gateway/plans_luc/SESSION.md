# SESSION · v2 P1/P2/P3 rolling fix

> 2026-04-26。本会话已完成 Codex v2 审查中 P1 全修、P2 大头与一组 P3 测试/脚本加固。
> 详细审查清单:`gateway/plans_luc/ISSUES.md`。

## P1 修复完成

| 任务 | 关键改动 |
|---|---|
| P1#5 cpaEdit 单图改用 `image` | `upstream.ts`: 按 `images.length` 选 `image` 或 `image[]`;`UPSTREAM_MODE` 改 lazy 读;新 `upstream-cpa.test.ts` |
| P1#1 bodyLimit + auth 顺序 | `index.ts`: 全局中间件按路径选 25MB(edits)/64KB(其他),挪到 auth 前;`MAX_EDIT_BODY_BYTES` lazy 读 |
| P1#2 MIME 真校验 | `index.ts`: `sniffImageMime()` magic-byte 识别 PNG/JPEG/WEBP;mask 给定时强制 image[0] 为 PNG |
| P1#4 错误脱敏 | `index.ts`: `redactSecrets()` 处理 Bearer/api-key/sk-*;新 `redact.test.ts` |
| P1#6 退款回归测试 | `edits.route.test.ts`: upstream fail 退款、insufficient credits 不动余额、validation 失败前不扣 |
| P1#3 扣费事务化 | `db.ts`: `beginRequest` / `completeRequest` / `failRequest` 三事务函数 |

## P2 修复完成

| 项 | 关键改动 |
|---|---|
| P2#7 mask 同尺寸校验仅对 PNG 输入生效 | mask 给定时强制 `image[0]` 必须是真实 PNG,并校验 PNG chunk/IDAT/IEND/CRC 结构 |
| P2#9 edit 计价忽略 mask 与 image 数量 | `calculateEditCost()` 支持 `{ n, hasMask, imageCount }`;路由传入 mask/image 数 |
| P2#10 /v1/usage 汇总不按 op 分桶 | `summarizeUsage()` GROUP BY `op, model, status` |
| P2#11 user_version 迁移并发竞态 | migration 改为 `BEGIN IMMEDIATE` + `PRAGMA table_info` 幂等列检查 |
| P2#13 usage 字段无运行时 schema 校验 | `sanitizeUsage()` 丢弃非法 usage 字段并归一化 finite number |
| P2#14/#15 资金不变式测试 | 402 和 validation 失败均断言余额/日志不异常变动 |
| P2#17 readPngDims 畸形 PNG 0 测试 | `png-sniff.test.ts` 覆盖短 buffer、坏 magic、坏 IHDR、0 尺寸、header-only、缺 IDAT、bad CRC 等 |
| P2#18 mockEdit token 弱断言 | `upstream.test.ts` 精确断言 input/output/total tokens,新增 2 图 case |
| P2#19 IMAGES_EDITS_ENABLED=false placeholder 测试 | `imagesEditsEnabled()` lazy 读 env,测试真实断言 503/service_unavailable |
| P2#20 smoke-edits.sh 大图前提 | 随机不可压缩大图按 `MAX_INPUT_IMAGE_BYTES` 生成并 assert 超限 |
| 性能审查补丁 | PNG CRC 改 table-driven;chunk type 改 byte 判断;prompt/model/n 先于 PNG 全量结构扫描;非 PNG 只读 bounded header;不保留 `imageBytes[]` |

## P3 修复完成

| 项 | 关键改动 |
|---|---|
| P3#25 smoke-edits.sh 不会失败 + 不在 CI | `run()` 接收期望 HTTP,不匹配直接非 0;`package.json` 新增 `smoke:edits` |
| P3#26 v1 generations 回归断言过弱 | generations 测试断言响应 usage/data 与 `usage_logs.{op,input_tokens,output_tokens,total_tokens,usage_json}` |

## 验证基线

- `bun test` → **116 pass / 0 fail / 276 expect**
- `bunx tsc --noEmit --pretty false -p tsconfig.json` → 干净
- `bash -n scripts/smoke-edits.sh` → 干净

## 仍未修/延后

- P2#8 recharge_logs 结构化 ledger:较大 schema/账务重构,建议单独做。
- P2#12 streaming multipart:较大路由/上传处理重构,建议单独做。
- P2#16 并发覆盖:建议下一轮加 Promise.all/WAL 余额守恒测试。
- P3#21/#22/#23/#24 仍在 `ISSUES.md`。

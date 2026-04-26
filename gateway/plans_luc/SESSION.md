# SESSION · v2 P1 全修

> 2026-04-26。Codex 5 路审查发现 6 个 P1,本会话全修完。
> 详细审查清单:`gateway/plans_luc/ISSUES.md`(P2×14 / P3×6 待续)。

## P1 修复完成

| # | 任务 | 关键改动 |
|---|------|---------|
| 53 | P1#5 cpaEdit 单图改用 `image` | `upstream.ts`: 按 `images.length` 选 `image` 或 `image[]`;`UPSTREAM_MODE` 改 lazy 读;新文件 `upstream-cpa.test.ts` 3 测试 |
| 54 | P1#1 bodyLimit + auth 顺序 | `index.ts`: 全局中间件按路径选 25MB(edits)/64KB(其他),挪到 auth 前;`MAX_EDIT_BODY_BYTES` 改 lazy 读避免 module-load-once 测试污染 |
| 55 | P1#2 MIME 真校验 | `index.ts`: 抽 `sniffImageMime()` magic-byte 识别 PNG/JPEG/WEBP;mask 给定时强制 image[0] 必须是 PNG;3 个新攻击测试 |
| 56 | P1#4 错误脱敏 | `index.ts`: 抽 `redactSecrets()` 用 regex 处理 `Bearer xxx`、`api[-_]?key=xxx`、`sk-xxx`;新文件 `redact.test.ts` 7 测试 |
| 57 | P1#6 退款回归测试 | `edits.route.test.ts`: 3 个新测试 (upstream fail 退款、insufficient credits 不动余额、validation 失败前不扣) |
| 58 | P1#3 扣费事务化 | `db.ts`: `beginRequest`(debit + insert pending) / `completeRequest` / `failRequest` 三事务函数替代 debitCredits + insertUsageLog + refundCredits 链;`index.ts` 两路由全改;新增 2 个事务一致性测试 |

## 验证基线

- `bun test` → **77 pass / 0 fail / 195 expect**
- `tsc --noEmit` → 干净
- 工作树:`db.ts` `index.ts` `upstream.ts` `edits.route.test.ts` 改;新 `redact.test.ts` `upstream-cpa.test.ts`
- 未 commit(等用户确认)

## 关键架构变更

1. **三事务计费**: `beginRequest`(debit+pending 同事务) → upstream → `completeRequest`(success) 或 `failRequest`(fail+refund 同事务)。崩溃在中间窗口会留下 `status='pending'` 行,可由 P3 startup-reconciler 清理。
2. **真 MIME 守门**: 不再信任客户端 `Content-Type`,只信任前 12 字节 magic。SVG/HTML 伪装 PNG/JPEG → 400。
3. **错误脱敏**: 任何 CPA 上游返回错误中包含的 Bearer/api-key/sk- 都在落库/打日志前 redact。
4. **bodyLimit 前置**: 未鉴权 oversize 直接 413,不浪费内存。
5. **lazy env 读取**: `UPSTREAM_MODE` `MAX_EDIT_BODY_BYTES` 改成函数式读取,解锁多文件测试隔离。

## 后续

- P2(14 条)和 P3(6 条)在 `ISSUES.md` 已分级。重点 P2:
  - #8 recharge_logs 结构化 ledger
  - #9 edit 计价纳入 mask/imageCount
  - #10 /v1/usage 按 op 分桶
  - #11 user_version 迁移并发竞态
  - #12 内存放大(streaming multipart)
  - #13 usage schema 校验
  - #16 0 并发覆盖
- 下次会话可起 dual-mode 把 P2 拆 5-6 个并行干。

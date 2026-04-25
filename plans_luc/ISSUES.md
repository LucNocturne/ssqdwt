# gateway — 已知问题与延后项 (P3)

## 来源
Codex 审查(2026-04-25),P1/P2 已修;P3 暂不阻断 demo,记此延后处理。

## P3 加固清单(量产前)

### 速率限制
- 网关无 per-key / per-IP 限流。生产前接 `hono/rate-limiter` 或 nginx/Caddy 反代层。
- **风险**:单 key 可打满 CPA 配额、触发上游风控。

### 访问日志
- 当前只在错误路径打 log。正常请求无 access log,出问题不可回溯。
- **建议**:加 structured access log(JSON,带 requestId、key_id、model、status、latency)。

### SQLite 备份
- WAL 模式下 `cp gateway.db` 不安全。
- **建议**:用 `VACUUM INTO` 或 litestream 做实时备份。

### CORS / CSRF
- 当前默认无 CORS。如未来要做管理 UI 走浏览器,需明确 allowlist。

### `seed.ts` / `loadtest.ts` 安全
- 脚本不会被 `bun start` 触发(✅),但 README 应明确"勿在生产 run loadtest"。
- 当前 README 未明示,生产部署文档时补。

### CPA `Authorization` 日志脱敏
- 当前不打 CPA 请求日志。后续若加 access log,需主动脱敏 `Authorization` header。

### 部署期权限
- `data/` 目录里的 sqlite 文件应 `chmod 600`,容器跑非 root。
- `.env` 文件同样。

### `/v1/usage` 性能
- `summarizeUsage(keyId)` 全表 GROUP BY,随 `usage_logs` 增长会变慢。
- **建议**:加 60s 缓存或限时间窗(`WHERE created_at > now-7d`)。

### disabled key 充值策略
- 当前允许充值已 disabled 的 key(`rechargeKey` 内部不查 disabled)。
- 是有意设计还是疏忽未明确,需产品决定后固化。

## P2 已修(本轮)

- ✅ KEY_HASH_SECRET 启动期硬校验(>= 32 chars,无兜底默认)
- ✅ admin token 用 `crypto.timingSafeEqual` 恒定时间比较
- ✅ 客户端 abort 不再传播给上游(账面与真上游消耗对齐)
- ✅ refundCredits 事务化 + 写 `recharge_logs(reason='refund:<requestId>')`
- ✅ 错误信息脱敏(上游 body 不再回灌响应,只进服务端日志和 usage_logs.error)
- ✅ 上游响应体大小上限(默认 50MB,防 OOM)
- ✅ key_prefix 缩短为 `sk-img-XXXX...`(原 12 字过多)
- ✅ Hono `bodyLimit` 64KB + prompt 字节数校验 32KB
- ✅ recharge delta 上下界 ±1,000,000(防 JS safe-int 溢出)
- ✅ 错误响应 status 收窄白名单扩展到 13 个常见 code

## P1 已修(本轮)

全部 5 项 P1 已修完,见上方"P2 已修"中标 ✅ 的前 4 项 + 大小响应体阈值。

# image-gateway

把 CPA(CLIProxyAPI)藏在我们域名后面、对外只暴露 OpenAI 兼容 API 的薄网关。

- **Bun + Hono + bun:sqlite**,单进程,demo 级实现。
- **不暴露 CPA 参数**:对外是 5 个固定规格名(`img-standard` / `img-hd` / `img-4k-square` / `img-4k-16x9` / `img-4k-9x16`),网关内部翻译成 CPA 的 size/quality。
- **credits 计费**:按规格倍率,预扣 → 上游成功保留 / 失败全额退还。不做伪 token 统计。
- **mock 模式**:未接 CPA 时返回 1×1 PNG,可独立压测网关性能。

## 目录

```
gateway/
├── src/
│   ├── index.ts      # Hono app + /v1/* 主路由
│   ├── admin.ts      # /admin/* 路由(独立 token)
│   ├── auth.ts       # 中间件(API key / admin / requestId)
│   ├── db.ts         # bun:sqlite + 原子扣费/退款
│   ├── models.ts     # 5 个规格 → CPA 参数映射
│   ├── upstream.ts   # mock + CPA 客户端
│   └── models.test.ts
├── scripts/seed.ts   # 命令行建第一个 API key
├── data/             # SQLite 文件落这里
├── .env.example
├── package.json
└── tsconfig.json
```

## 一、跑起来

```bash
cd gateway
bun install
cp .env.example .env
# 编辑 .env:务必把 ADMIN_TOKEN 改掉(默认值会被中间件主动拒绝)

# mock 模式启动(默认)
ADMIN_TOKEN=your-secret bun run dev
# 看到:gateway listening on :8787 (upstream=mock)
```

健康检查:
```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","upstream":"mock","time":"..."}
```

## 二、建 key + 调一张图

### 创建 API key(admin)

```bash
curl -X POST http://127.0.0.1:8787/admin/keys \
  -H "X-Admin-Token: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"label":"customer-A","initial_credits":1000}'
```

返回里有 `api_key: sk-img-xxxxx` — **只显示一次**,记下来。

或者命令行 seed:
```bash
bun run seed customer-A 1000
```

### 看可用规格

```bash
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer sk-img-xxxxx"
```

| model name | size | quality | credits/image |
|---|---|---|---|
| `img-standard` | 1024×1024 | medium | 1 |
| `img-hd` | 1024×1024 | high | 3 |
| `img-4k-square` | 2048×2048 | high | 8 |
| `img-4k-16x9` | 2048×1152 | high | 8 |
| `img-4k-9x16` | 1152×2048 | high | 8 |

### 出图(OpenAI 风格)

```bash
curl -X POST http://127.0.0.1:8787/v1/images/generations \
  -H "Authorization: Bearer sk-img-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"img-hd","prompt":"a cyberpunk cat","n":2}'
```

响应:
```json
{
  "created": 1777122323,
  "model": "img-hd",
  "data": [
    {"b64_json": "iVBORw0...", "revised_prompt": "..."},
    {"b64_json": "iVBORw0...", "revised_prompt": "..."}
  ],
  "usage": {"credits": 6, "n": 2}
}
```

### 查余额 / 用量

```bash
curl http://127.0.0.1:8787/v1/usage -H "Authorization: Bearer sk-img-xxxxx"
```

## 三、接真实 CPA

`.env` 改 3 项:

```env
UPSTREAM_MODE=cpa
CPA_BASE_URL=http://your-cpa-host:8004
CPA_API_KEY=cpa-side-key-if-any   # CPA 那侧 config.yaml api-keys 里配的
```

重启网关。请求路径不变。失败/超时由网关接住并自动退款。

## 四、admin 接口清单

所有 `/admin/*` 都需要 header `X-Admin-Token: ...`。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/admin/keys` | 建 key,body `{label, initial_credits}` |
| GET  | `/admin/keys` | 列出所有 key(不返回明文) |
| POST | `/admin/keys/:id/recharge` | 充值/扣费,body `{delta, reason}` |
| POST | `/admin/keys/:id/disable` | 禁用 key |
| GET  | `/admin/usage` | 全站调用汇总 |

## 五、压测

mock 模式下网关本身的吞吐:

```bash
# 安装一次:cargo install oha 或 brew install oha
oha -n 2000 -c 50 -m POST \
  -H "Authorization: Bearer sk-img-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"img-standard","prompt":"x"}' \
  http://127.0.0.1:8787/v1/images/generations
```

预期 mock 模式下 p99 < 100ms(本地),错误率 0,数据库余额 = 初始 - 成功数 × 单价。

接了 CPA 后吞吐由 CPA 决定,网关只是薄壳;此时压测主要验证错误处理和退款一致性。

## 六、几个关键设计

1. **API key 不存明文**,只存 `sha256(pepper + key)`;数据库泄露也无法直接复用 key。
2. **预扣是一条 SQL**(`UPDATE ... WHERE balance >= ?`),并发安全,无需事务。
3. **失败退款用 +=**,不会把余额加回到错误的位置(只回当前状态)。
4. **请求里不允许客户传 size/quality** — 全部由 model name 决定,避免客户绕开计价表。
5. **`change-me-please` 默认 ADMIN_TOKEN 会被中间件拒绝**,防误部署。

## 七、Demo 阶段不做的事(故意)

- token-level 计费(图片场景伪复杂,不做)
- webhook / 异步任务(同步 200 即可)
- 用户管理 / 多租户(一个 sk- 一个客户)
- 多上游 fallback(留给"稳定后再上量"阶段)
- 真持久化用 Postgres(SQLite 文件 demo 够用)

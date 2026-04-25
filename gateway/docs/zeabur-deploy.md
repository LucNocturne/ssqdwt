# 部署到 Zeabur

## 一键部署(同项目内)

把 gateway 部署到与 cliproxyapi 相同的 Zeabur 项目里,可以走内网域名 `cliproxyapi.zeabur.internal:8080` 调用 CPA,不需要给 CPA 暴露公网。

### 步骤

1. **新建服务** → 选 GitHub repo(指向本仓库 `gateway/` 目录)。Zeabur 会自动识别 `Dockerfile`。
2. 部署完成后,进入服务的"环境变量",**必填**:
   - `KEY_HASH_SECRET` = `openssl rand -hex 32` 输出
   - `ADMIN_TOKEN` = `openssl rand -hex 16` 输出
   - `UPSTREAM_MODE` = `mock`(先) 或 `cpa`(等 CPA 修好后)
3. 进入"硬盘",创建一个 volume,id = `data`,挂载到 `/app/data`(SQLite 文件落这里)。
4. 进入"网络":
   - 内网端口 8080 改成 **8787**
   - 加一个公网域名(让客户能调)
5. 重启服务,看日志应有 `gateway listening on :8787 (upstream=mock)`。

### 创建第一个客户 key

```bash
ADMIN=<你设的 ADMIN_TOKEN>
GATEWAY=https://your-domain.zeabur.app

curl -X POST $GATEWAY/admin/keys \
  -H "X-Admin-Token: $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"label":"customer-A","initial_credits":1000}'
```

返回里的 `api_key: sk-img-xxx` **只显示一次**,记下。

### 切到真 CPA 上游

CPA 修好后(参考 `docs/cpa-deploy.md` 的诊断报告):
1. 改 env `UPSTREAM_MODE=cpa`
2. `CPA_BASE_URL=http://cliproxyapi.zeabur.internal:8080`(默认就是这个,无需改)
3. 如果 CPA 那侧 config.yaml 里配了 `api-keys`,把那个 key 填到 `CPA_API_KEY`
4. 重启,客户端请求路径不变。

## 当前已知阻塞:CPA 部署本身有问题

当前 cliproxyapi 服务 CrashLoopBackOff,根因在 `docs/cpa-deploy.md`。在 CPA 修复前:
- gateway 用 `UPSTREAM_MODE=mock` 可独立先上,演示流程、计费、规格名都正确
- 切真上游只需改 1 个 env,无代码改动

## 排查

| 现象 | 检查 |
|---|---|
| 启动报 `KEY_HASH_SECRET must be set...` | env 没填或 < 32 chars |
| `/admin/*` 返回 503 `ADMIN_TOKEN not configured` | env 没填、是占位符或 < 16 chars |
| 客户端 `502 upstream error` | UPSTREAM_MODE=cpa 但 CPA 服务挂了 — 看 `docs/cpa-deploy.md` |
| `/v1/usage` 余额不变 | 客户用的 model 不在 5 个规格内 → 自动 rejected,不扣费 |

## 健康检查

`/health` 返回 `{"status":"ok","upstream":"mock|cpa","time":"..."}`。Dockerfile 已带 HEALTHCHECK,Zeabur 会自动用。

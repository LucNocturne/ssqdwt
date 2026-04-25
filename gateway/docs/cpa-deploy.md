# cliproxyapi 服务部署诊断 (2026-04-25)

## 现状

Zeabur 项目 `suy`(id `69c50c76e11ead6d2df004eb`)的 `cliproxyapi` 服务:
- 状态:**Service is suspended**(CrashLoopBackOff 后被自动暂停)
- 最近部署:`feat(api): implement protocol multiplexer and Redis queue for usage integration`,状态 `REMOVED`
- Volume:挂载 `/date`(疑似拼写错,且**与 CPA 期望的 config 路径无关**)
- 网络:HTTP 8080 内网,**无公网域名**,**未暴露 1455(OAuth)**
- 环境变量:有 `PASSWORD` / `PORT`,以及自动注入的 MySQL/Postgres/Redis 跨服务连接;**无 CPA 相关配置**

## 根因(两层)

### 第一层:容器启不来

```
[error] [main.go:393] failed to load config:
  open /CLIProxyAPI/config.yaml: no such file or directory
```

CPA 二进制启动期硬要求 `/CLIProxyAPI/config.yaml`。当前镜像里没,Volume 也没挂到这个位置。

### 第二层:即使容器起来,也不可用

CPA 设计上需要 OAuth 登录绑定 ChatGPT/Codex 账号:
- 端口 1455 接收 OAuth 回调
- 通常做法:`docker exec -d cli-proxy-api sh -c 'CLIProxyAPI -no-browser --codex-login &> oauth.log'`
- 然后 SSH tunnel 把 1455 暴露到本机浏览器,完成授权

**Zeabur PaaS 没有 web shell / SSH 入口,这一步在平台内做不了。**

## 修复路径(三选一)

### 路径 A:demo 期绕开,gateway 用 mock 上游
- gateway 已有 `UPSTREAM_MODE=mock`,出图返回 1×1 占位 PNG
- 流程、计费、规格名对客户演示无差异
- CPA 服务保持 suspend(避免 CrashLoop 反复刷日志/计费)
- **今天就能交付**

### 路径 B:在 fork repo 加默认 config + 离线完成 OAuth
1. fork 的 CPA repo 里改 Dockerfile,`COPY config.yaml /CLIProxyAPI/config.yaml`(放最小配置)
2. 本地 docker run 同镜像,SSH tunnel 1455 → 浏览器跑 OAuth → 拿 `~/.cli-proxy-api/codex-*.json`
3. 把 token 文件作为 Zeabur Volume 内容上传,或用 `entrypoint.sh` 从 secret env 写文件
4. Zeabur Volume 改挂 `/CLIProxyAPI`(注意会覆盖镜像内文件,需用 init container 或 entrypoint 拷贝)
5. push → 自动 rebuild
- **耗时:0.5–1 天**

### 路径 C:换平台
CPA 强依赖 shell 完成 OAuth,与 Zeabur 这种纯 PaaS 不兼容。换:
- VPS + docker-compose(参考 [locdd 实测帖](https://www.locdd.com/t/topic/43328))
- Fly.io(支持 `fly ssh console`)
- 自己的 NAS / 云主机
- **这是 CPA 设计上匹配的部署形态**

## 推荐执行顺序

1. **今天**:走路径 A,gateway 部署到 Zeabur 同项目,`UPSTREAM_MODE=mock`,demo 给客户看
2. **本周**:走路径 C,把 CPA 搬到 VPS / NAS,做完 OAuth
3. **完成后**:gateway 改 `UPSTREAM_MODE=cpa` + `CPA_BASE_URL=https://your-cpa-vps:8004` + `CPA_API_KEY=...`,重启即切换

## Zeabur 上的具体清理建议

- `cliproxyapi` 服务保持 suspend(不要再点重启,CrashLoop 没意义)
- `date` volume(拼写错)可删可不删 — 没数据
- 项目内其他服务(MySQL / Postgres / Redis / ccpool-* / New API)与本部署解耦,不动

## 备注:为什么 commit 是 protocol multiplexer 那个奇怪标题

那是 router-for-me/CLIProxyAPI 主仓近期的 commit(给 management API 加 Redis queue),与本次部署失败**无直接关系**。失败原因纯粹是 config.yaml 缺失。

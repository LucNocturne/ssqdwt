# syntax=docker/dockerfile:1.6
FROM oven/bun:1.3.9-alpine AS deps
WORKDIR /app
COPY package.json bun.lockb* bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.9-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# SQLite + admin token 务必由部署平台注入 env;不在镜像里写默认值。
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/index.ts"]

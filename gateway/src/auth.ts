import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { findKeyByHash, hashApiKey, type ApiKeyRow } from "./db.ts";

declare module "hono" {
  interface ContextVariableMap {
    apiKey: ApiKeyRow;
    requestId: string;
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const auth = c.req.header("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return c.json(
      { error: { type: "auth_error", message: "Missing or malformed Authorization header" } },
      401,
    );
  }
  const plain = m[1]!.trim();
  const row = findKeyByHash(hashApiKey(plain));
  if (!row) {
    return c.json({ error: { type: "auth_error", message: "Invalid API key" } }, 401);
  }
  c.set("apiKey", row);
  await next();
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function adminAuthMiddleware(c: Context, next: Next) {
  const want = process.env.ADMIN_TOKEN;
  if (!want || want === "change-me-please" || want.length < 16) {
    return c.json(
      {
        error: {
          type: "config_error",
          message: "ADMIN_TOKEN not configured (must be set, >= 16 chars, not the placeholder)",
        },
      },
      503,
    );
  }
  const got = c.req.header("X-Admin-Token") ?? "";
  if (!constantTimeEqual(got, want)) {
    return c.json({ error: { type: "auth_error", message: "Invalid admin token" } }, 401);
  }
  await next();
}

export async function requestIdMiddleware(c: Context, next: Next) {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
}

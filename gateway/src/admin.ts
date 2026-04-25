import { Hono } from "hono";
import { z } from "zod";
import { adminAuthMiddleware } from "./auth.ts";
import { createKey, db, findKeyById, rechargeKey, summarizeUsage } from "./db.ts";

export const adminApp = new Hono();
adminApp.use("*", adminAuthMiddleware);

const CreateKeyReq = z.object({
  label: z.string().min(1).max(64),
  initial_credits: z.number().int().min(0).default(1000),
});

adminApp.post("/keys", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateKeyReq.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { type: "invalid_request", message: parsed.error.issues[0]?.message ?? "bad body" } },
      400,
    );
  }
  const { label, initial_credits } = parsed.data;
  const k = createKey(label, initial_credits);
  return c.json({
    id: k.id,
    label: k.label,
    credits: k.credits,
    api_key: k.plain,
    note: "Save this api_key now — it is shown only once.",
  });
});

adminApp.get("/keys", (c) => {
  const rows = db
    .query("SELECT id, key_prefix, label, credits_balance, disabled, created_at FROM api_keys")
    .all();
  return c.json({ data: rows });
});

const RechargeReq = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().min(1).max(64).default("manual"),
});

adminApp.post("/keys/:id/recharge", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { type: "invalid_request", message: "bad id" } }, 400);
  }
  if (!findKeyById(id)) {
    return c.json({ error: { type: "not_found", message: "key not found" } }, 404);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = RechargeReq.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { type: "invalid_request", message: parsed.error.issues[0]?.message ?? "bad body" } },
      400,
    );
  }
  try {
    const newBalance = rechargeKey(id, parsed.data.delta, parsed.data.reason);
    return c.json({ id, new_balance: newBalance, delta: parsed.data.delta });
  } catch (e) {
    return c.json(
      { error: { type: "invalid_request", message: (e as Error).message } },
      400,
    );
  }
});

adminApp.post("/keys/:id/disable", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { type: "invalid_request", message: "bad id" } }, 400);
  }
  const res = db.query("UPDATE api_keys SET disabled = 1 WHERE id = ?").run(id);
  if (res.changes === 0) {
    return c.json({ error: { type: "not_found", message: "key not found" } }, 404);
  }
  return c.json({ id, disabled: true });
});

adminApp.get("/usage", (c) => c.json({ summary: summarizeUsage() }));

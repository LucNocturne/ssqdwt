import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authMiddleware, requestIdMiddleware } from "./auth.ts";
import {
  debitCredits,
  findKeyById,
  insertUsageLog,
  refundCredits,
  summarizeUsage,
} from "./db.ts";
import { calculateCost, getModelSpec, listModels } from "./models.ts";
import { adminApp } from "./admin.ts";
import { generateImage, UpstreamError, upstreamMode } from "./upstream.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;

const app = new Hono();
app.use("*", requestIdMiddleware);
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: { type: "invalid_request", message: "request body too large" } }, 413),
  }),
);

// ---------- public health ----------
app.get("/health", (c) =>
  c.json({ status: "ok", upstream: upstreamMode, time: new Date().toISOString() }),
);

// ---------- /admin/* (separate token) ----------
app.route("/admin", adminApp);

// ---------- everything below requires sk- ----------
app.use("/v1/*", authMiddleware);

app.get("/v1/models", (c) => c.json({ object: "list", data: listModels() }));

app.get("/v1/usage", (c) => {
  const key = c.get("apiKey");
  const fresh = findKeyById(key.id);
  return c.json({
    key_id: key.id,
    label: key.label,
    credits_balance: fresh?.credits_balance ?? key.credits_balance,
    summary: summarizeUsage(key.id),
  });
});

const ImagesReq = z.object({
  model: z.string().min(1).max(64),
  prompt: z
    .string()
    .min(1)
    .max(8000)
    .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_PROMPT_BYTES, {
      message: "prompt exceeds byte limit",
    }),
  n: z.number().int().min(1).max(8).default(1),
});

app.post("/v1/images/generations", async (c) => {
  const key = c.get("apiKey");
  const requestId = c.get("requestId");
  const t0 = performance.now();

  // ---- 1. parse + validate ----
  const body = await c.req.json().catch(() => null);
  const parsed = ImagesReq.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: {
          type: "invalid_request",
          message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
      400,
    );
  }
  const { model, prompt, n } = parsed.data;

  const spec = getModelSpec(model);
  if (!spec) {
    insertUsageLog({
      keyId: key.id,
      requestId,
      model,
      n,
      status: "rejected",
      credits: 0,
      latencyMs: Math.round(performance.now() - t0),
      error: "unknown_model",
    });
    return c.json(
      {
        error: {
          type: "invalid_request",
          message: `Unknown model '${model}'. See GET /v1/models.`,
        },
      },
      400,
    );
  }

  const cost = calculateCost(spec, n);

  // ---- 2. atomic debit ----
  if (!debitCredits(key.id, cost)) {
    insertUsageLog({
      keyId: key.id,
      requestId,
      model,
      n,
      status: "rejected",
      credits: 0,
      latencyMs: Math.round(performance.now() - t0),
      error: "insufficient_credits",
    });
    return c.json(
      {
        error: {
          type: "insufficient_credits",
          message: `This request costs ${cost} credits.`,
        },
      },
      402,
    );
  }

  // ---- 3. call upstream (does NOT carry client abort — billing must match real upstream usage) ----
  try {
    const upstream = await generateImage(spec, prompt, n);
    const latencyMs = Math.round(performance.now() - t0);
    insertUsageLog({
      keyId: key.id,
      requestId,
      model,
      n,
      status: "success",
      credits: cost,
      latencyMs,
    });
    return c.json({
      created: upstream.created,
      model,
      data: upstream.data,
      usage: { credits: cost, n },
    });
  } catch (err) {
    refundCredits(key.id, cost, requestId);
    const latencyMs = Math.round(performance.now() - t0);
    const isUpstream = err instanceof UpstreamError;
    const status = isUpstream ? err.status : 502;
    const publicMessage = isUpstream ? err.message : "upstream error";
    const detail = isUpstream ? (err.detail ?? "") : (err as Error).message;

    insertUsageLog({
      keyId: key.id,
      requestId,
      model,
      n,
      status: "failed",
      credits: 0,
      latencyMs,
      error: detail ? `${publicMessage} | ${detail}` : publicMessage,
    });
    console.error(
      `[${requestId}] upstream_error key=${key.id} model=${model} status=${status} detail=${truncateForLog(detail, 200)}`,
    );
    return c.json(
      {
        error: {
          type: "upstream_error",
          message: publicMessage,
          retriable: isUpstream ? err.retriable : true,
        },
      },
      coerceClientStatus(status),
    );
  }
});

function truncateForLog(s: string, n: number): string {
  const safe = s.replace(/[\r\n]+/g, " ");
  return safe.length > n ? `${safe.slice(0, n)}...` : safe;
}

function coerceClientStatus(s: number): 400 | 401 | 402 | 403 | 404 | 408 | 413 | 429 | 500 | 502 | 503 | 504 {
  const allowed = [400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504] as const;
  return (allowed.find((x) => x === s) ?? 502) as
    | 400 | 401 | 402 | 403 | 404 | 408 | 413 | 429 | 500 | 502 | 503 | 504;
}

app.notFound((c) =>
  c.json({ error: { type: "not_found", message: `${c.req.method} ${c.req.path}` } }, 404),
);

app.onError((err, c) => {
  console.error(`[${c.get("requestId") ?? "-"}]`, err);
  return c.json({ error: { type: "internal_error", message: "internal error" } }, 500);
});

const port = Number(process.env.PORT ?? 8787);
console.log(`gateway listening on :${port} (upstream=${upstreamMode})`);

export default { port, fetch: app.fetch };

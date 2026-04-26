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
import {
  calculateCost,
  calculateEditCost,
  getModelSpec,
  listModels,
} from "./models.ts";
import { adminApp } from "./admin.ts";
import { editImage, generateImage, UpstreamError, upstreamMode } from "./upstream.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EDIT_BODY_BYTES = Number(process.env.MAX_EDIT_BODY_BYTES ?? 25 * 1024 * 1024);
const MAX_INPUT_IMAGE_BYTES = Number(process.env.MAX_INPUT_IMAGE_BYTES ?? 4 * 1024 * 1024);
const MAX_INPUT_IMAGES = Number(process.env.MAX_INPUT_IMAGES ?? 4);
const MAX_PROMPT_BYTES = 32 * 1024;
const ALLOWED_INPUT_MIME = new Set(["image/png", "image/webp", "image/jpeg"]);
const IMAGES_EDITS_ENABLED = (process.env.IMAGES_EDITS_ENABLED ?? "true") !== "false";

const app = new Hono();
app.use("*", requestIdMiddleware);
app.use("*", async (c, next) => {
  // /v1/images/edits has its own larger limit; skip the 64KB global gate.
  if (c.req.path === "/v1/images/edits") return next();
  return bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (cc) =>
      cc.json({ error: { type: "invalid_request", message: "request body too large" } }, 413),
  })(c, next);
});

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
      op: "generation",
      usage: upstream.usage ?? null,
    });
    return c.json({
      created: upstream.created,
      model,
      data: upstream.data,
      usage: upstream.usage
        ? { ...upstream.usage, credits: cost, n }
        : { credits: cost, n },
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

// ============================================================
// /v1/images/edits — image-to-image + mask inpainting + multi-ref
// ============================================================

const EditPromptSchema = z
  .string()
  .min(1)
  .max(8000)
  .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_PROMPT_BYTES, {
    message: "prompt exceeds byte limit",
  });

/** PNG magic + IHDR width/height. Returns null if not a valid PNG header. */
function readPngDims(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG signature 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
    buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a
  ) {
    return null;
  }
  // IHDR chunk: bytes 12..15 = "IHDR"
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) {
    return null;
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

app.post(
  "/v1/images/edits",
  bodyLimit({
    maxSize: MAX_EDIT_BODY_BYTES,
    onError: (c) =>
      c.json({ error: { type: "invalid_request", message: "request body too large" } }, 413),
  }),
  async (c) => {
    const key = c.get("apiKey");
    const requestId = c.get("requestId");
    const t0 = performance.now();

    if (!IMAGES_EDITS_ENABLED) {
      return c.json(
        { error: { type: "service_unavailable", message: "edits endpoint disabled" } },
        503,
      );
    }

    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = (await c.req.parseBody({ all: true })) as typeof form;
    } catch {
      return c.json(
        { error: { type: "invalid_request", message: "malformed multipart body" } },
        400,
      );
    }

    // ---- collect images ----
    const rawImages = (form["image[]"] ?? form["image"]) as
      | File
      | (string | File)[]
      | string
      | undefined;
    const images: File[] = [];
    if (Array.isArray(rawImages)) {
      for (const it of rawImages) if (it instanceof File) images.push(it);
    } else if (rawImages instanceof File) {
      images.push(rawImages);
    }
    if (images.length === 0) {
      return c.json(
        { error: { type: "invalid_request", message: "missing image field" } },
        400,
      );
    }
    if (images.length > MAX_INPUT_IMAGES) {
      return c.json(
        {
          error: {
            type: "invalid_request",
            message: `too many input images (max ${MAX_INPUT_IMAGES})`,
          },
        },
        400,
      );
    }
    for (const img of images) {
      if (img.size > MAX_INPUT_IMAGE_BYTES) {
        return c.json(
          { error: { type: "invalid_request", message: "input image too large" } },
          413,
        );
      }
      if (!ALLOWED_INPUT_MIME.has(img.type)) {
        return c.json(
          {
            error: {
              type: "invalid_request",
              message: `unsupported image format '${img.type}'`,
            },
          },
          400,
        );
      }
    }

    // ---- mask (optional) ----
    const rawMask = form["mask"];
    const mask = rawMask instanceof File ? rawMask : undefined;
    if (mask) {
      if (mask.size > MAX_INPUT_IMAGE_BYTES) {
        return c.json(
          { error: { type: "invalid_request", message: "mask too large" } },
          413,
        );
      }
      if (mask.type !== "image/png") {
        return c.json(
          { error: { type: "invalid_request", message: "mask must be PNG" } },
          400,
        );
      }
      const maskBytes = new Uint8Array(await mask.arrayBuffer()).slice(0, 24);
      const maskDims = readPngDims(maskBytes);
      if (!maskDims) {
        return c.json(
          { error: { type: "invalid_request", message: "mask is not a valid PNG" } },
          400,
        );
      }
      const firstImage = images[0]!;
      let imgDims: { width: number; height: number } | null = null;
      if (firstImage.type === "image/png") {
        const imgBytes = new Uint8Array(await firstImage.arrayBuffer()).slice(0, 24);
        imgDims = readPngDims(imgBytes);
      }
      if (
        imgDims &&
        (imgDims.width !== maskDims.width || imgDims.height !== maskDims.height)
      ) {
        return c.json(
          {
            error: {
              type: "invalid_request",
              message: `mask size ${maskDims.width}x${maskDims.height} != image[0] size ${imgDims.width}x${imgDims.height}`,
            },
          },
          400,
        );
      }
    }

    // ---- prompt / model / n ----
    const promptRaw = form["prompt"];
    const promptStr = typeof promptRaw === "string" ? promptRaw : "";
    const promptParsed = EditPromptSchema.safeParse(promptStr);
    if (!promptParsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request",
            message: promptParsed.error.issues
              .map((i) => `prompt: ${i.message}`)
              .join("; "),
          },
        },
        400,
      );
    }
    const prompt = promptParsed.data;

    const modelRaw = form["model"];
    const model = typeof modelRaw === "string" ? modelRaw : "";
    if (!model || model.length > 64) {
      return c.json(
        { error: { type: "invalid_request", message: "missing or invalid model" } },
        400,
      );
    }

    const nRaw = form["n"];
    const nParsed = nRaw === undefined ? 1 : Number(nRaw);
    if (!Number.isInteger(nParsed) || nParsed < 1 || nParsed > 8) {
      return c.json(
        { error: { type: "invalid_request", message: "n must be integer in [1,8]" } },
        400,
      );
    }
    const n = nParsed;

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
        op: "edit",
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

    const cost = calculateEditCost(spec, n);

    // ---- atomic debit ----
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
        op: "edit",
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

    // ---- upstream ----
    try {
      const upstream = await editImage(spec, prompt, n, images, mask);
      const latencyMs = Math.round(performance.now() - t0);
      insertUsageLog({
        keyId: key.id,
        requestId,
        model,
        n,
        status: "success",
        credits: cost,
        latencyMs,
        op: "edit",
        usage: upstream.usage ?? null,
      });
      return c.json({
        created: upstream.created,
        model,
        data: upstream.data,
        usage: upstream.usage
          ? { ...upstream.usage, credits: cost, n }
          : { credits: cost, n },
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
        op: "edit",
      });
      console.error(
        `[${requestId}] upstream_error_edit key=${key.id} model=${model} status=${status} detail=${truncateForLog(detail, 200)}`,
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
  },
);

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

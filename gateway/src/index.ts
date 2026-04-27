import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authMiddleware, requestIdMiddleware } from "./auth.ts";
import {
  beginRequest,
  completeRequest,
  ensureGatewayApiKeyFromEnv,
  failRequest,
  findKeyById,
  insertUsageLog,
  summarizeUsage,
} from "./db.ts";
import {
  calculateCost,
  calculateEditCost,
  getModelSpec,
  listModels,
  resolveDims,
  isValidCombo,
  type Aspect,
  type Resolution,
} from "./models.ts";
import { adminApp } from "./admin.ts";
import { editImage, generateImage, UpstreamError, upstreamMode } from "./upstream.ts";

const MAX_BODY_BYTES = 64 * 1024;
const editBodyLimit = () =>
  Number(process.env.MAX_EDIT_BODY_BYTES ?? 25 * 1024 * 1024);
const MAX_INPUT_IMAGE_BYTES = Number(process.env.MAX_INPUT_IMAGE_BYTES ?? 4 * 1024 * 1024);
const MAX_INPUT_IMAGES = Number(process.env.MAX_INPUT_IMAGES ?? 4);
const MAX_PROMPT_BYTES = 32 * 1024;
const ALLOWED_INPUT_MIME = new Set(["image/png", "image/webp", "image/jpeg"]);
const imagesEditsEnabled = () => (process.env.IMAGES_EDITS_ENABLED ?? "true") !== "false";

const gatewayApiKey = ensureGatewayApiKeyFromEnv();
if (gatewayApiKey) {
  console.log(
    `gateway api key ready id=${gatewayApiKey.id} prefix=${gatewayApiKey.prefix} created=${gatewayApiKey.created}`,
  );
}

const app = new Hono();
app.use("*", requestIdMiddleware);
app.use("*", async (c, next) => {
  // Apply body limits BEFORE auth so unauthenticated/wrong-method requests
  // can't waste memory. /v1/images/edits gets the larger 25MB cap; everything
  // else gets the default 64KB cap.
  const isEditsPath = c.req.path === "/v1/images/edits";
  const maxSize = isEditsPath ? editBodyLimit() : MAX_BODY_BYTES;
  return bodyLimit({
    maxSize,
    onError: (cc) =>
      cc.json({ error: { type: "invalid_request", message: "request body too large" } }, 413),
  })(c, next);
});

// ---------- public health ----------
app.get("/health", (c) =>
  c.json({ status: "ok", time: new Date().toISOString() }),
);

// ---------- /admin/* (separate token) ----------
app.route("/admin", adminApp);

// ---------- everything below requires sk- ----------
app.use("/v1/*", authMiddleware);

app.get("/v1/models", (c) => c.json({ object: "list", data: listModels() }));

// ---------- OpenRouter-style compatibility ----------
// OpenRouter-style image generation uses /api/v1/chat/completions with
// modalities:["image"]. We expose a thin compatibility layer while keeping
// /v1/images/generations as the native gateway API.
app.use("/api/v1/*", authMiddleware);

app.get("/api/v1/models", (c) => {
  const outputModalities = c.req.query("output_modalities");
  return c.json({ data: listOpenRouterModels(outputModalities) });
});

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

const OpenRouterChatReq = z.object({
  model: z.string().min(1).max(128).optional(),
  messages: z.array(z.object({
    role: z.string().optional(),
    content: z.unknown(),
  })).min(1),
  modalities: z.array(z.enum(["text", "image", "audio"])).optional(),
  image_config: z.object({
    aspect_ratio: z.string().optional(),
    image_size: z.string().optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
  }).passthrough().optional(),
  n: z.number().int().min(1).max(8).optional(),
  stream: z.boolean().optional(),
});

type OpenRouterImageConfig = z.infer<typeof OpenRouterChatReq>["image_config"];

function listOpenRouterModels(outputModalities?: string) {
  const requested = (outputModalities ?? "image")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const includeImages =
    requested.length === 0 ||
    requested.includes("all") ||
    requested.includes("image");
  if (!includeImages) return [];

  return listModels().map((m) => ({
    id: m.id,
    canonical_slug: m.id,
    name: m.id,
    created: 1777161600,
    description: m.description,
    context_length: 8192,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["image"],
      tokenizer: "unknown",
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
      request: "0",
      image: "0",
      web_search: "0",
      internal_reasoning: "0",
      input_cache_read: "0",
      input_cache_write: "0",
    },
    top_provider: {
      context_length: 8192,
      max_completion_tokens: null,
      is_moderated: true,
    },
    per_request_limits: null,
    supported_parameters: ["modalities", "image_config"],
    default_parameters: null,
    expiration_date: null,
    size: m.size,
    quality: m.quality,
  }));
}

function normalizeResolution(v: string | undefined): Resolution | null {
  const s = v?.trim().toLowerCase();
  if (!s) return null;
  if (s === "1k") return "1k";
  if (s === "2k") return "2k";
  if (s === "4k") return "4k";
  return null;
}

function normalizeAspect(v: string | undefined): Aspect | null {
  const s = v?.trim().toLowerCase().replace(":", "x") as Aspect | undefined;
  if (!s) return null;
  return isValidCombo("2k", s) || isValidCombo("1k", s) || isValidCombo("4k", s)
    ? s
    : null;
}

function modelForExactSize(size: string | undefined, quality: string | undefined): string | null {
  if (!size) return null;
  const q = quality?.trim().toLowerCase();
  const models = listModels().filter((m) => m.size === size);
  if (q) {
    const exact = models.find((m) => m.quality === q);
    if (exact) return exact.id;
  }
  const standard = models.find((m) => m.id === "img-standard");
  if (standard) return standard.id;
  return models[0]?.id ?? null;
}

function modelFromImageConfig(model: string | undefined, imageConfig: OpenRouterImageConfig): string {
  if (model && getModelSpec(model)) return model;

  const exactSize = modelForExactSize(imageConfig?.size, imageConfig?.quality);
  if (exactSize) return exactSize;

  const res = normalizeResolution(imageConfig?.image_size) ?? "1k";
  const aspect =
    normalizeAspect(imageConfig?.aspect_ratio) ??
    (res === "4k" ? "16x9" : "1x1");
  if (isValidCombo(res, aspect)) {
    const [w, h] = resolveDims(res, aspect);
    const bySize = modelForExactSize(`${w}x${h}`, imageConfig?.quality);
    if (bySize) return bySize;
  }

  return "img-standard";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const obj = part as Record<string, unknown>;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.content === "string") return obj.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractPrompt(messages: { role?: string; content?: unknown }[]): string {
  const user = [...messages].reverse().find((m) => (m.role ?? "user") === "user");
  return messageText(user?.content);
}

app.post("/api/v1/chat/completions", async (c) => {
  const key = c.get("apiKey");
  const requestId = c.get("requestId");
  const t0 = performance.now();

  const body = await c.req.json().catch(() => null);
  const parsed = OpenRouterChatReq.safeParse(body);
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

  const modalities = parsed.data.modalities ?? ["image"];
  if (!modalities.includes("image")) {
    return c.json(
      { error: { type: "invalid_request", message: "Only image output is supported. Set modalities:['image']." } },
      400,
    );
  }
  if (parsed.data.stream) {
    return c.json(
      { error: { type: "invalid_request", message: "stream is not supported by this gateway" } },
      400,
    );
  }

  const prompt = extractPrompt(parsed.data.messages);
  const promptParsed = ImagesReq.shape.prompt.safeParse(prompt);
  if (!promptParsed.success) {
    return c.json(
      {
        error: {
          type: "invalid_request",
          message: promptParsed.error.issues.map((i) => `prompt: ${i.message}`).join("; "),
        },
      },
      400,
    );
  }

  const model = modelFromImageConfig(parsed.data.model, parsed.data.image_config);
  const spec = getModelSpec(model);
  if (!spec) {
    return c.json(
      { error: { type: "invalid_request", message: `Unknown model '${model}'. See GET /api/v1/models?output_modalities=image.` } },
      400,
    );
  }

  const n = parsed.data.n ?? 1;
  const cost = calculateCost(spec, n);
  const logId = beginRequest({
    keyId: key.id,
    cost,
    requestId,
    model,
    n,
    op: "generation",
  });
  if (logId === null) {
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
      { error: { type: "insufficient_credits", message: `This request costs ${cost} credits.` } },
      402,
    );
  }

  try {
    const upstream = await generateImage(spec, promptParsed.data, n);
    const latencyMs = Math.round(performance.now() - t0);
    completeRequest({ logId, latencyMs, usage: upstream.usage ?? null });
    return c.json({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion",
      created: upstream.created,
      model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Image generated.",
            images: upstream.data.map((img) => ({
              type: "image_url",
              image_url: {
                url: img.b64_json
                  ? `data:image/png;base64,${img.b64_json}`
                  : (img.url ?? ""),
              },
            })),
          },
        },
      ],
      usage: {
        prompt_tokens: upstream.usage?.input_tokens ?? 0,
        completion_tokens: upstream.usage?.output_tokens ?? 0,
        total_tokens: upstream.usage?.total_tokens ?? 0,
      },
    });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const isUpstream = err instanceof UpstreamError;
    const status = isUpstream ? err.status : 502;
    const publicMessage = isUpstream ? err.message : "upstream error";
    const detail = redactSecrets(
      isUpstream ? (err.detail ?? "") : (err as Error).message,
    );
    failRequest({
      logId,
      keyId: key.id,
      cost,
      requestId,
      latencyMs,
      error: detail ? `${publicMessage} | ${detail}` : publicMessage,
    });
    console.error(
      `[${requestId}] openrouter_upstream_error key=${key.id} model=${model} status=${status} detail=${truncateForLog(detail, 200)}`,
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

  // ---- 2. atomic debit + pending log row ----
  const logId = beginRequest({
    keyId: key.id,
    cost,
    requestId,
    model,
    n,
    op: "generation",
  });
  if (logId === null) {
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
    completeRequest({ logId, latencyMs, usage: upstream.usage ?? null });
    return c.json({
      created: upstream.created,
      model,
      data: upstream.data,
      usage: upstream.usage
        ? { ...upstream.usage, credits: cost, n }
        : { credits: cost, n },
    });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    const isUpstream = err instanceof UpstreamError;
    const status = isUpstream ? err.status : 502;
    const publicMessage = isUpstream ? err.message : "upstream error";
    const detail = redactSecrets(
      isUpstream ? (err.detail ?? "") : (err as Error).message,
    );

    failRequest({
      logId,
      keyId: key.id,
      cost,
      requestId,
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

/**
 * Redact secrets that may appear in upstream error bodies before persisting/logging.
 * Covers Authorization/Bearer tokens, common api-key shapes, sk-* tokens.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(authorization|bearer|api[-_]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, "sk-[REDACTED]");
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
export function readPngDims(buf: Uint8Array): { width: number; height: number } | null {
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

/** Sniff true MIME by magic bytes. Never trust client Content-Type. */


const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array, start: number, length: number): number {
  let crc = 0xffffffff;
  const end = start + length;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isAsciiLetterByte(b: number): boolean {
  return (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}

export function isStructurallyValidPng(buf: Uint8Array): boolean {
  if (!readPngDims(buf)) return false;
  let offset = 8;
  let seenIhdr = false;
  let seenIdat = false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (offset + 12 <= buf.length) {
    const length = dv.getUint32(offset, false);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (nextOffset > buf.length) return false;
    const a = buf[typeOffset]!;
    const b = buf[typeOffset + 1]!;
    const c = buf[typeOffset + 2]!;
    const d = buf[typeOffset + 3]!;
    if (!isAsciiLetterByte(a) || !isAsciiLetterByte(b) || !isAsciiLetterByte(c) || !isAsciiLetterByte(d)) {
      return false;
    }
    const expectedCrc = dv.getUint32(crcOffset, false);
    if (crc32(buf, typeOffset, 4 + length) !== expectedCrc) return false;
    const isIhdr = a === 0x49 && b === 0x48 && c === 0x44 && d === 0x52;
    const isIdat = a === 0x49 && b === 0x44 && c === 0x41 && d === 0x54;
    const isIend = a === 0x49 && b === 0x45 && c === 0x4e && d === 0x44;
    if (!seenIhdr) {
      if (!isIhdr || length !== 13) return false;
      seenIhdr = true;
    } else if (isIhdr) {
      return false;
    }
    if (isIdat) seenIdat = true;
    if (isIend) return seenIdat && length === 0 && nextOffset === buf.length;
    offset = nextOffset;
  }
  return false;
}

export function sniffImageMime(buf: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length < 12) return null;
  // PNG
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export async function readFileHead(file: File, n: number): Promise<Uint8Array> {
  const slice = (file as unknown as { slice(start?: number, end?: number): Blob }).slice(0, n);
  return new Uint8Array(await slice.arrayBuffer());
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

app.post(
  "/v1/images/edits",
  async (c) => {
    const key = c.get("apiKey");
    const requestId = c.get("requestId");
    const t0 = performance.now();

    if (!imagesEditsEnabled()) {
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

    const sniffedMimes: ("image/png" | "image/jpeg" | "image/webp")[] = [];
    let firstImageDims: { width: number; height: number } | null = null;
    for (const [idx, img] of images.entries()) {
      if (img.size > MAX_INPUT_IMAGE_BYTES) {
        return c.json(
          { error: { type: "invalid_request", message: "input image too large" } },
          413,
        );
      }
      const head = await readFileHead(img, 24);
      const sniffed = sniffImageMime(head);
      if (!sniffed || !ALLOWED_INPUT_MIME.has(sniffed)) {
        return c.json(
          {
            error: {
              type: "invalid_request",
              message: "unsupported image format (must be png/jpeg/webp by content)",
            },
          },
          400,
        );
      }
      if (sniffed === "image/png") {
        const bytes = await readFileBytes(img);
        if (!isStructurallyValidPng(bytes)) {
          return c.json(
            { error: { type: "invalid_request", message: "invalid PNG image" } },
            400,
          );
        }
        if (idx === 0) firstImageDims = readPngDims(head);
      }
      sniffedMimes.push(sniffed);
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
      const maskBytes = await readFileBytes(mask);
      const maskHead = maskBytes.subarray(0, Math.min(24, maskBytes.byteLength));
      if (sniffImageMime(maskHead) !== "image/png") {
        return c.json(
          { error: { type: "invalid_request", message: "mask must be PNG" } },
          400,
        );
      }
      const maskDims = readPngDims(maskHead);
      if (!maskDims || !isStructurallyValidPng(maskBytes)) {
        return c.json(
          { error: { type: "invalid_request", message: "mask is not a valid PNG" } },
          400,
        );
      }
      // When mask is given, image[0] MUST be a real PNG so we can compare dims.
      if (sniffedMimes[0] !== "image/png") {
        return c.json(
          {
            error: {
              type: "invalid_request",
              message: "image[0] must be PNG when mask is provided",
            },
          },
          400,
        );
      }
      const imgDims = firstImageDims;
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

    const cost = calculateEditCost(spec, {
      n,
      hasMask: !!mask,
      imageCount: images.length,
    });

    // ---- atomic debit + pending log row ----
    const logId = beginRequest({
      keyId: key.id,
      cost,
      requestId,
      model,
      n,
      op: "edit",
    });
    if (logId === null) {
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
      completeRequest({ logId, latencyMs, usage: upstream.usage ?? null });
      return c.json({
        created: upstream.created,
        model,
        data: upstream.data,
        usage: upstream.usage
          ? { ...upstream.usage, credits: cost, n }
          : { credits: cost, n },
      });
    } catch (err) {
      const latencyMs = Math.round(performance.now() - t0);
      const isUpstream = err instanceof UpstreamError;
      const status = isUpstream ? err.status : 502;
      const publicMessage = isUpstream ? err.message : "upstream error";
      const detail = redactSecrets(
        isUpstream ? (err.detail ?? "") : (err as Error).message,
      );

      failRequest({
        logId,
        keyId: key.id,
        cost,
        requestId,
        latencyMs,
        error: detail ? `${publicMessage} | ${detail}` : publicMessage,
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

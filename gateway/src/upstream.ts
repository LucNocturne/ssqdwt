import type { ModelSpec } from "./models.ts";

const UPSTREAM_MODE = (process.env.UPSTREAM_MODE ?? "mock") as "mock" | "cpa";
const CPA_BASE_URL = process.env.CPA_BASE_URL ?? "http://127.0.0.1:8004";
const CPA_API_KEY = process.env.CPA_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 120_000);
const MAX_RESPONSE_BYTES = Number(process.env.UPSTREAM_MAX_RESPONSE_BYTES ?? 50 * 1024 * 1024);

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status: number,
    public retriable: boolean,
    /** 内部诊断信息,**不应**回给客户端 */
    public detail?: string,
  ) {
    super(message);
  }
}

export type UpstreamImage = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
};

export type UpstreamResult = {
  created: number;
  data: UpstreamImage[];
  upstream_quality?: string;
  upstream_size?: string;
};

/**
 * NOTE: We intentionally do NOT propagate the client request's AbortSignal
 * to the upstream fetch. If the client disconnects mid-flight, we still let
 * upstream complete (and bill it), so our books match real CPA usage.
 * Only the per-request hard timeout cancels upstream.
 */
export async function generateImage(
  spec: ModelSpec,
  prompt: string,
  n: number,
): Promise<UpstreamResult> {
  if (UPSTREAM_MODE === "mock") return mockGenerate(spec, prompt, n);
  return cpaGenerate(spec, prompt, n);
}

// ---------- mock ----------
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function mockGenerate(spec: ModelSpec, prompt: string, n: number): Promise<UpstreamResult> {
  await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 300)));
  return {
    created: Math.floor(Date.now() / 1000),
    data: Array.from({ length: n }, () => ({
      b64_json: TINY_PNG_B64,
      revised_prompt: `[mock] ${prompt.slice(0, 80)}`,
    })),
    upstream_quality: spec.upstream.quality,
    upstream_size: spec.upstream.size,
  };
}

// ---------- CPA ----------
async function cpaGenerate(spec: ModelSpec, prompt: string, n: number): Promise<UpstreamResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${CPA_BASE_URL}/v1/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CPA_API_KEY ? { Authorization: `Bearer ${CPA_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: spec.upstream.model,
        prompt,
        n,
        size: spec.upstream.size,
        quality: spec.upstream.quality,
        output_format: spec.upstream.output_format,
      }),
      signal: ctrl.signal,
    });

    const declaredLength = Number(res.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new UpstreamError("upstream response too large", 502, false);
    }

    const bodyText = await readCappedText(res, MAX_RESPONSE_BYTES);

    if (!res.ok) {
      const retriable = res.status === 429 || res.status >= 500;
      // 不把 bodyText 回给客户端,避免泄漏内部细节
      throw new UpstreamError(
        `upstream rejected request (status ${res.status})`,
        res.status,
        retriable,
        truncate(bodyText, 500),
      );
    }

    let json: { created?: number; data?: UpstreamImage[]; quality?: string; size?: string };
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new UpstreamError("upstream returned non-JSON body", 502, true);
    }

    if (!json.data || !Array.isArray(json.data) || json.data.length === 0) {
      throw new UpstreamError("upstream returned empty data", 502, true);
    }
    return {
      created: json.created ?? Math.floor(Date.now() / 1000),
      data: json.data,
      upstream_quality: json.quality,
      upstream_size: json.size,
    };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new UpstreamError("upstream timeout", 504, true);
    }
    throw new UpstreamError(
      "upstream fetch failed",
      502,
      true,
      truncate((err as Error).message ?? "", 200),
    );
  } finally {
    clearTimeout(t);
  }
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError("upstream response too large", 502, false);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export const upstreamMode = UPSTREAM_MODE;

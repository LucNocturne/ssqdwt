// Verify cpaEdit FormData field naming: single-image uses "image", multi uses "image[]".
process.env.UPSTREAM_MODE = "cpa";
process.env.CPA_BASE_URL = "http://stub";
process.env.CPA_API_KEY = "k";
process.env.UPSTREAM_TIMEOUT_MS = "5000";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let captured: FormData | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.UPSTREAM_MODE = "cpa";
  captured = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = init.body as FormData;
    return new Response(
      JSON.stringify({
        created: 1,
        data: [{ b64_json: "x" }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.UPSTREAM_MODE = "mock";
});

const png = (name = "a.png") =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

describe("cpaEdit field naming", () => {
  test("single image uses 'image' (not 'image[]')", async () => {
    const { editImage } = await import("../src/upstream.ts");
    const { getModelSpec } = await import("../src/models.ts");
    const spec = getModelSpec("img-standard")!;
    await editImage(spec, "p", 1, [png("only.png")]);
    expect(captured).not.toBeNull();
    const keys = [...captured!.keys()];
    expect(keys).toContain("image");
    expect(keys).not.toContain("image[]");
  });

  test("multi image uses 'image[]'", async () => {
    const { editImage } = await import("../src/upstream.ts");
    const { getModelSpec } = await import("../src/models.ts");
    const spec = getModelSpec("img-standard")!;
    await editImage(spec, "p", 1, [png("a.png"), png("b.png")]);
    expect(captured).not.toBeNull();
    const all = captured!.getAll("image[]");
    expect(all.length).toBe(2);
    expect(captured!.get("image")).toBeNull();
  });

  test("mask carried through with single image", async () => {
    const { editImage } = await import("../src/upstream.ts");
    const { getModelSpec } = await import("../src/models.ts");
    const spec = getModelSpec("img-standard")!;
    await editImage(spec, "p", 1, [png()], png("mask.png"));
    expect(captured!.get("mask")).not.toBeNull();
    expect(captured!.get("image")).not.toBeNull();
  });
});

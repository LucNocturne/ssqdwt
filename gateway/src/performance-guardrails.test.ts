import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

process.env.KEY_HASH_SECRET ??= "0".repeat(64);
process.env.UPSTREAM_MODE = "mock";
process.env.DB_PATH = ":memory:";
process.env.IMAGES_EDITS_ENABLED = "true";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const smokeEditsSource = readFileSync(new URL("../scripts/smoke-edits.sh", import.meta.url), "utf8");

describe("performance guardrails", () => {
  test("PNG CRC uses table lookup instead of per-byte bit loops", () => {
    expect(indexSource).toContain("CRC_TABLE");
    expect(indexSource).not.toMatch(/for \(let bit = 0; bit < 8; bit\+\+\)/);
  });

  test("PNG chunk parsing avoids string and regex checks in the hot path", () => {
    expect(indexSource).not.toContain("String.fromCharCode");
    expect(indexSource).not.toMatch(/\^\[A-Za-z\]\{4\}\$/);
  });

  test("bounded file reads use slice instead of full arrayBuffer", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.readFileHead).toBe("function");
    const file = new File([new Uint8Array(1024 * 1024)], "x.jpg", { type: "image/jpeg" });
    let fullReads = 0;
    const originalArrayBuffer = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      fullReads++;
      return originalArrayBuffer();
    };

    const head = await mod.readFileHead(file, 24);

    expect(head.byteLength).toBe(24);
    expect(fullReads).toBe(0);
  });

  test("scalar validation is ordered before PNG structural scan", () => {
    expect(indexSource.indexOf("const promptParsed = EditPromptSchema.safeParse(promptStr)")).toBeLessThan(
      indexSource.indexOf("isStructurallyValidPng(bytes)"),
    );
  });

  test("scalar validation runs before PNG structural scan", async () => {
    const mod = await import("../src/index.ts");
    const { createKey } = await import("../src/db.ts");
    const key = createKey("scalar-first", 100_000);
    const png = new Uint8Array(1024 * 1024);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0, 0, 0, 13], 8);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(png.buffer).setUint32(16, 1024, false);
    new DataView(png.buffer).setUint32(20, 1024, false);
    const file = new File([png], "x.png", { type: "image/png" });
    let fullReads = 0;
    const originalArrayBuffer = file.arrayBuffer.bind(file);
    file.arrayBuffer = async () => {
      fullReads++;
      return originalArrayBuffer();
    };
    const body = new FormData();
    body.append("model", "img-standard");
    body.append("image", file, file.name);

    const res = await mod.default.fetch(
      new Request("http://localhost/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.plain}` },
        body,
      }),
    );

    expect(res.status).toBe(400);
    expect(fullReads).toBe(0);
  });

  test("smoke big fixture follows configurable MAX_INPUT_IMAGE_BYTES", () => {
    expect(smokeEditsSource).toContain(": \"${MAX_INPUT_IMAGE_BYTES:=4194304}\"");
    expect(smokeEditsSource).toContain("MAX_INPUT_IMAGE_BYTES");
    expect(smokeEditsSource).not.toContain("assert size > 4 * 1024 * 1024");
  });
});

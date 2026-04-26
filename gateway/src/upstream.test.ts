import { describe, expect, test } from "bun:test";
import { editImage, generateImage, sanitizeUsage } from "../src/upstream.ts";
import { getModelSpec } from "../src/models.ts";

const spec = getModelSpec("img-standard")!;

describe("upstream mock generate", () => {
  test("returns n images with usage", async () => {
    const r = await generateImage(spec, "test prompt", 2);
    expect(r.data.length).toBe(2);
    expect(r.data[0]?.b64_json).toBeTruthy();
    expect(r.usage).toBeDefined();
    expect(r.usage?.input_tokens).toBeGreaterThan(0);
    expect(r.usage?.output_tokens).toBeGreaterThan(0);
    expect(r.usage?.total_tokens).toBe(
      (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0),
    );
  });

  test("usage details nested", async () => {
    const r = await generateImage(spec, "p", 1);
    expect(r.usage?.input_tokens_details?.text_tokens).toBeGreaterThan(0);
    expect(r.usage?.output_tokens_details?.image_tokens).toBeGreaterThan(0);
  });
});

describe("upstream mock edit", () => {
  test("returns n images with usage including input image_tokens", async () => {
    const fakeImage = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "in.png", {
      type: "image/png",
    });
    const r = await editImage(spec, "edit", 1, [fakeImage]);
    expect(r.data.length).toBe(1);
    expect(r.usage?.input_tokens_details?.image_tokens).toBe(1024);
    expect(r.usage?.input_tokens).toBeGreaterThanOrEqual(1024);
  });

  test("revised_prompt reflects mock-edit tag", async () => {
    const fakeImage = new File([new Uint8Array([0x89])], "in.png", { type: "image/png" });
    const r = await editImage(spec, "make it red", 1, [fakeImage]);
    expect(r.data[0]?.revised_prompt).toMatch(/\[mock-edit\]/);
  });
});

describe("sanitizeUsage", () => {
  test("drops NaN", () => {
    const r = sanitizeUsage({ input_tokens: NaN, output_tokens: 5 });
    expect(r?.input_tokens).toBeUndefined();
    expect(r?.output_tokens).toBe(5);
  });
  test("drops Infinity", () => {
    const r = sanitizeUsage({ input_tokens: Infinity, output_tokens: 5 });
    expect(r?.input_tokens).toBeUndefined();
  });
  test("drops string fields silently", () => {
    const r = sanitizeUsage({ input_tokens: "12", output_tokens: 5 } as unknown);
    expect(r?.input_tokens).toBeUndefined();
    expect(r?.output_tokens).toBe(5);
  });
  test("drops negative", () => {
    const r = sanitizeUsage({ input_tokens: -1, output_tokens: 5 });
    expect(r?.input_tokens).toBeUndefined();
  });
  test("floors fractional values", () => {
    const r = sanitizeUsage({ input_tokens: 12.7 });
    expect(r?.input_tokens).toBe(12);
  });
  test("keeps nested details when valid", () => {
    const r = sanitizeUsage({
      input_tokens: 10,
      input_tokens_details: { text_tokens: 4, image_tokens: 6 },
      output_tokens_details: { text_tokens: NaN, image_tokens: 3 },
    });
    expect(r?.input_tokens_details?.text_tokens).toBe(4);
    expect(r?.output_tokens_details?.text_tokens).toBeUndefined();
    expect(r?.output_tokens_details?.image_tokens).toBe(3);
  });
  test("returns undefined for non-object input", () => {
    expect(sanitizeUsage(null)).toBeUndefined();
    expect(sanitizeUsage(undefined)).toBeUndefined();
    expect(sanitizeUsage("usage")).toBeUndefined();
    expect(sanitizeUsage(42)).toBeUndefined();
  });
  test("returns undefined for empty object", () => {
    expect(sanitizeUsage({})).toBeUndefined();
  });
});

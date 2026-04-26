import { describe, expect, test } from "bun:test";
import { editImage, generateImage } from "../src/upstream.ts";
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

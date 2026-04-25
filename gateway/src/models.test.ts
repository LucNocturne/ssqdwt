import { describe, expect, test } from "bun:test";
import { calculateCost, getModelSpec, listModels, MODEL_SPECS } from "../src/models.ts";

describe("models", () => {
  test("getModelSpec hits known model", () => {
    const spec = getModelSpec("img-hd");
    expect(spec).not.toBeNull();
    expect(spec?.creditsPerImage).toBe(3);
    expect(spec?.upstream.quality).toBe("high");
  });

  test("getModelSpec returns null for unknown", () => {
    expect(getModelSpec("dall-e-3")).toBeNull();
    expect(getModelSpec("")).toBeNull();
  });

  test("calculateCost scales with n", () => {
    const spec = MODEL_SPECS["img-2k-square"]!;
    expect(calculateCost(spec, 1)).toBe(8);
    expect(calculateCost(spec, 4)).toBe(32);
  });

  test("calculateCost rejects bad n", () => {
    const spec = MODEL_SPECS["img-standard"]!;
    expect(() => calculateCost(spec, 0)).toThrow();
    expect(() => calculateCost(spec, -1)).toThrow();
    expect(() => calculateCost(spec, 1.5)).toThrow();
  });

  test("listModels returns 5 entries", () => {
    const list = listModels();
    expect(list).toHaveLength(5);
    expect(list.map((m) => m.id).sort()).toEqual([
      "img-2k-square",
      "img-hd",
      "img-standard",
      "img-uhd-16x9",
      "img-uhd-9x16",
    ]);
  });

  test("every spec has complete upstream fields", () => {
    for (const spec of Object.values(MODEL_SPECS)) {
      expect(spec.upstream.size).toMatch(/^\d+x\d+$/);
      expect(["low", "medium", "high"]).toContain(spec.upstream.quality);
      expect(["png", "webp"]).toContain(spec.upstream.output_format);
      expect(spec.creditsPerImage).toBeGreaterThan(0);
    }
  });
});

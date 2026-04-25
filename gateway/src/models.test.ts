import { describe, expect, test } from "bun:test";
import {
  calculateCost,
  getModelSpec,
  isValidCombo,
  listModels,
  MODEL_SPECS,
  resolveDims,
} from "../src/models.ts";

describe("resolveDims", () => {
  test("square 1K", () => expect(resolveDims("1k", "1x1")).toEqual([1024, 1024]));
  test("4:3 1K", () => expect(resolveDims("1k", "4x3")).toEqual([1024, 768]));
  test("3:4 1K", () => expect(resolveDims("1k", "3x4")).toEqual([768, 1024]));
  test("16:9 4K = real UHD", () => expect(resolveDims("4k", "16x9")).toEqual([3840, 2160]));
  test("9:16 4K = vertical UHD", () => expect(resolveDims("4k", "9x16")).toEqual([2160, 3840]));
  test("16:9 2K", () => expect(resolveDims("2k", "16x9")).toEqual([2048, 1152]));
});

describe("isValidCombo", () => {
  test("4K 1:1 rejected (pixel budget)", () => expect(isValidCombo("4k", "1x1")).toBe(false));
  test("1K 16:9 rejected (too small)", () => expect(isValidCombo("1k", "16x9")).toBe(false));
  test("2K 1:1 ok", () => expect(isValidCombo("2k", "1x1")).toBe(true));
  test("4K 16:9 ok", () => expect(isValidCombo("4k", "16x9")).toBe(true));
});

describe("MODEL_SPECS derivation", () => {
  test("img-standard kept as legacy cheap entry", () => {
    expect(getModelSpec("img-standard")).toBeTruthy();
    expect(getModelSpec("img-standard")!.creditsPerImage).toBe(1);
    expect(getModelSpec("img-standard")!.upstream.quality).toBe("medium");
  });

  test("derives only valid combos + img-standard", () => {
    const ids = listModels().map((m) => m.id).sort();
    expect(ids).toEqual([
      "img-1k-1x1",
      "img-1k-3x4",
      "img-1k-4x3",
      "img-2k-16x9",
      "img-2k-1x1",
      "img-2k-3x4",
      "img-2k-4x3",
      "img-2k-9x16",
      "img-4k-16x9",
      "img-4k-9x16",
      "img-standard",
    ]);
  });

  test("4K UHD priced 16cr", () => {
    expect(getModelSpec("img-4k-16x9")!.creditsPerImage).toBe(16);
    expect(getModelSpec("img-4k-9x16")!.creditsPerImage).toBe(16);
  });

  test("invalid combos return null", () => {
    expect(getModelSpec("img-4k-1x1")).toBeNull();
    expect(getModelSpec("img-1k-16x9")).toBeNull();
    expect(getModelSpec("img-2k-square")).toBeNull(); // old name
  });

  test("calculateCost rejects bad n", () => {
    const spec = MODEL_SPECS["img-standard"]!;
    expect(() => calculateCost(spec, 0)).toThrow();
    expect(calculateCost(spec, 4)).toBe(4);
  });

  test("every spec has a valid size string", () => {
    for (const m of Object.values(MODEL_SPECS)) {
      expect(m.upstream.size).toMatch(/^\d+x\d+$/);
    }
  });
});

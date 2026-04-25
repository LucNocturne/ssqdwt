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
  test("3:2 2K = 2048x1365", () => expect(resolveDims("2k", "3x2")).toEqual([2048, 1365]));
  test("5:4 2K = 2048x1638", () => expect(resolveDims("2k", "5x4")).toEqual([2048, 1638]));
  test("2:1 2K = 2048x1024", () => expect(resolveDims("2k", "2x1")).toEqual([2048, 1024]));
  test("21:9 4K = 3840x1646", () => expect(resolveDims("4k", "21x9")).toEqual([3840, 1646]));
  test("2:1 4K = 3840x1920", () => expect(resolveDims("4k", "2x1")).toEqual([3840, 1920]));
});

describe("isValidCombo", () => {
  test("4K 1:1 rejected (pixel budget)", () => expect(isValidCombo("4k", "1x1")).toBe(false));
  test("1K 16:9 rejected (too small)", () => expect(isValidCombo("1k", "16x9")).toBe(false));
  test("2K 1:1 ok", () => expect(isValidCombo("2k", "1x1")).toBe(true));
  test("4K 16:9 ok", () => expect(isValidCombo("4k", "16x9")).toBe(true));
  test("2K 3:2 ok", () => expect(isValidCombo("2k", "3x2")).toBe(true));
  test("4K 21:9 ok", () => expect(isValidCombo("4k", "21x9")).toBe(true));
  test("4K 5:4 rejected (pixel budget exceeds)", () => expect(isValidCombo("4k", "5x4")).toBe(false));
});

describe("MODEL_SPECS derivation", () => {
  test("img-standard kept as legacy cheap entry", () => {
    expect(getModelSpec("img-standard")).toBeTruthy();
    expect(getModelSpec("img-standard")!.creditsPerImage).toBe(1);
    expect(getModelSpec("img-standard")!.upstream.quality).toBe("medium");
  });

  test("img-1k-1024x1024-low is the speed lane", () => {
    const m = getModelSpec("img-1k-1024x1024-low");
    expect(m).toBeTruthy();
    expect(m!.creditsPerImage).toBe(1);
    expect(m!.upstream.quality).toBe("low");
  });

  test("derives only valid combos + legacy aliases", () => {
    const ids = listModels().map((m) => m.id).sort();
    expect(ids).toEqual([
      "img-1k-1024x1024",
      "img-1k-1024x1024-low",
      "img-1k-1024x768",
      "img-1k-768x1024",
      "img-2k-1024x2048",
      "img-2k-1152x2048",
      "img-2k-1365x2048",
      "img-2k-1536x2048",
      "img-2k-1638x2048",
      "img-2k-2048x1024",
      "img-2k-2048x1152",
      "img-2k-2048x1365",
      "img-2k-2048x1536",
      "img-2k-2048x1638",
      "img-2k-2048x2048",
      "img-4k-1646x3840",
      "img-4k-1920x3840",
      "img-4k-2160x3840",
      "img-4k-3840x1646",
      "img-4k-3840x1920",
      "img-4k-3840x2160",
      "img-standard",
    ]);
  });

  test("UHD 4K priced 16cr", () => {
    expect(getModelSpec("img-4k-3840x2160")!.creditsPerImage).toBe(16);
    expect(getModelSpec("img-4k-2160x3840")!.creditsPerImage).toBe(16);
    expect(getModelSpec("img-4k-3840x1920")!.creditsPerImage).toBe(16);
    expect(getModelSpec("img-4k-3840x1646")!.creditsPerImage).toBe(16);
  });

  test("2K square / 4:3 / 5:4 / 3:2 priced 8cr", () => {
    expect(getModelSpec("img-2k-2048x2048")!.creditsPerImage).toBe(8);
    expect(getModelSpec("img-2k-2048x1536")!.creditsPerImage).toBe(8);
    expect(getModelSpec("img-2k-2048x1638")!.creditsPerImage).toBe(8);
    expect(getModelSpec("img-2k-2048x1365")!.creditsPerImage).toBe(8);
  });

  test("2K 16:9 / 2:1 priced 3cr", () => {
    expect(getModelSpec("img-2k-2048x1152")!.creditsPerImage).toBe(3);
    expect(getModelSpec("img-2k-2048x1024")!.creditsPerImage).toBe(3);
  });

  test("invalid combos / legacy aspect names return null", () => {
    expect(getModelSpec("img-4k-1x1")).toBeNull();
    expect(getModelSpec("img-1k-16x9")).toBeNull();
    expect(getModelSpec("img-2k-square")).toBeNull();
    expect(getModelSpec("img-2k-16x9")).toBeNull();
    expect(getModelSpec("img-2048x2048")).toBeNull();
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

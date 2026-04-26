import { describe, expect, test } from "bun:test";
import { calculateEditCost, EDIT_MULTIPLIER, getModelSpec, MODEL_SPECS } from "../src/models.ts";

describe("ModelSpec.tokenMultiplier", () => {
  test("1k specs have multiplier 1.0", () => {
    const m = getModelSpec("img-1k-1024x1024-low");
    expect(m?.tokenMultiplier).toBe(1.0);
  });

  test("2k specs have multiplier 4.0", () => {
    const m = getModelSpec("img-2k-2048x2048");
    expect(m?.tokenMultiplier).toBe(4.0);
  });

  test("4k specs have multiplier 8.5", () => {
    const m = getModelSpec("img-4k-3840x2160");
    expect(m?.tokenMultiplier).toBe(8.5);
  });

  test("img-standard (legacy) gets 1.0", () => {
    const m = getModelSpec("img-standard");
    expect(m?.tokenMultiplier).toBe(1.0);
  });

  test("every spec has tokenMultiplier", () => {
    for (const spec of Object.values(MODEL_SPECS)) {
      expect(typeof spec.tokenMultiplier).toBe("number");
      expect(spec.tokenMultiplier).toBeGreaterThan(0);
    }
  });
});

describe("calculateEditCost", () => {
  test("EDIT_MULTIPLIER is 1.5", () => {
    expect(EDIT_MULTIPLIER).toBe(1.5);
  });

  test("1k 1024x1024 edit n=1 = ceil(1*1.0*1.5*1) = 2", () => {
    const m = getModelSpec("img-standard")!;
    expect(calculateEditCost(m, 1)).toBe(2);
  });

  test("1k edit n=4 = ceil(1*1.0*1.5*4) = 6", () => {
    const m = getModelSpec("img-standard")!;
    expect(calculateEditCost(m, 4)).toBe(6);
  });

  test("2k 2048x2048 edit n=1 = ceil(8*4.0*1.5*1) = 48", () => {
    const m = getModelSpec("img-2k-2048x2048")!;
    expect(calculateEditCost(m, 1)).toBe(48);
  });

  test("4k 3840x2160 edit n=1 = ceil(16*8.5*1.5*1) = 204", () => {
    const m = getModelSpec("img-4k-3840x2160")!;
    expect(calculateEditCost(m, 1)).toBe(204);
  });

  test("invalid n throws", () => {
    const m = getModelSpec("img-standard")!;
    expect(() => calculateEditCost(m, 0)).toThrow();
    expect(() => calculateEditCost(m, -1)).toThrow();
    expect(() => calculateEditCost(m, 1.5)).toThrow();
  });

  test("hasMask adds MASK_SURCHARGE = 1.5x", () => {
    const m = getModelSpec("img-standard")!;
    // base 2 → with mask: ceil(1*1.0*1.5*1.5*1) = 3
    expect(calculateEditCost(m, { n: 1, hasMask: true })).toBe(3);
  });

  test("imageCount=2 adds 25%, imageCount=4 adds 75%", () => {
    const m = getModelSpec("img-standard")!;
    // 2 imgs: ceil(1*1.0*1.5*1.25*1) = 2
    expect(calculateEditCost(m, { n: 1, imageCount: 2 })).toBe(2);
    // 4 imgs: ceil(1*1.0*1.5*(1+0.25*3)*1) = ceil(1.5*1.75) = 3
    expect(calculateEditCost(m, { n: 1, imageCount: 4 })).toBe(3);
  });

  test("mask + 4 images stack multiplicatively", () => {
    const m = getModelSpec("img-standard")!;
    // ceil(1 * 1.0 * 1.5 * 1.5 * 1.75 * 1) = ceil(3.9375) = 4
    expect(calculateEditCost(m, { n: 1, hasMask: true, imageCount: 4 })).toBe(4);
  });

  test("invalid imageCount throws", () => {
    const m = getModelSpec("img-standard")!;
    expect(() => calculateEditCost(m, { n: 1, imageCount: 0 })).toThrow();
    expect(() => calculateEditCost(m, { n: 1, imageCount: -1 })).toThrow();
  });

  test("number form still works (backwards compatible)", () => {
    const m = getModelSpec("img-standard")!;
    expect(calculateEditCost(m, 1)).toBe(calculateEditCost(m, { n: 1 }));
  });
});

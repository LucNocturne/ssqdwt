process.env.KEY_HASH_SECRET ??= "0".repeat(64);
process.env.UPSTREAM_MODE = "mock";
process.env.DB_PATH = ":memory:";

import { beforeAll, describe, expect, test } from "bun:test";

let readPngDims: (buf: Uint8Array) => { width: number; height: number } | null;
let sniffImageMime: (buf: Uint8Array) => "image/png" | "image/jpeg" | "image/webp" | null;
let isStructurallyValidPng: (buf: Uint8Array) => boolean;

beforeAll(async () => {
  const mod = await import("../src/index.ts");
  readPngDims = mod.readPngDims;
  sniffImageMime = mod.sniffImageMime;
  isStructurallyValidPng = mod.isStructurallyValidPng;
});

describe("isStructurallyValidPng", () => {
  test("header-only PNG is not structurally valid", () => {
    expect(isStructurallyValidPng(makePngHeader(1, 1))).toBe(false);
  });

  test("minimal IHDR+IDAT+IEND PNG is structurally valid", () => {
    expect(isStructurallyValidPng(makeTinyPng(1, 1))).toBe(true);
  });

  test("oversized chunk length is rejected without reading past buffer", () => {
    const png = makeTinyPng(1, 1);
    const dv = new DataView(png.buffer);
    dv.setUint32(33, 0xfffffff0, false);
    expect(isStructurallyValidPng(png)).toBe(false);
  });
});

function makePngHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0, 0, 0, 13], 8);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return buf;
}

function testCrc32(buf: Uint8Array, start: number, length: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < start + length; i++) {
    crc ^= buf[i]!;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeTinyPng(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(58);
  buf.set(makePngHeader(width, height), 0);
  buf[24] = 8;
  buf[25] = 6;
  buf.set([0, 0, 0], 26);
  const dv = new DataView(buf.buffer);
  dv.setUint32(29, testCrc32(buf, 12, 17), false);
  buf.set([0, 0, 0, 1], 33);
  buf.set([0x49, 0x44, 0x41, 0x54], 37);
  buf[41] = 0;
  dv.setUint32(42, testCrc32(buf, 37, 5), false);
  buf.set([0, 0, 0, 0], 46);
  buf.set([0x49, 0x45, 0x4e, 0x44], 50);
  dv.setUint32(54, testCrc32(buf, 50, 4), false);
  return buf;
}

describe("readPngDims malformed inputs", () => {
  test("buffer < 24 bytes → null", () => {
    expect(readPngDims(new Uint8Array(0))).toBeNull();
    expect(readPngDims(new Uint8Array(8))).toBeNull();
    expect(readPngDims(new Uint8Array(23))).toBeNull();
  });

  test("wrong PNG magic → null", () => {
    const buf = makePngHeader(100, 100);
    buf[0] = 0x88; // corrupt magic
    expect(readPngDims(buf)).toBeNull();
  });

  test("missing IHDR marker → null", () => {
    const buf = makePngHeader(100, 100);
    buf[12] = 0x00; // corrupt IHDR
    expect(readPngDims(buf)).toBeNull();
  });

  test("width=0 → null", () => {
    expect(readPngDims(makePngHeader(0, 100))).toBeNull();
  });

  test("height=0 → null", () => {
    expect(readPngDims(makePngHeader(100, 0))).toBeNull();
  });

  test("valid header returns dims", () => {
    expect(readPngDims(makePngHeader(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  test("max uint32 dims still parsed (no overflow)", () => {
    const buf = makePngHeader(0xffffffff, 0xffffffff);
    const r = readPngDims(buf);
    expect(r?.width).toBe(0xffffffff);
    expect(r?.height).toBe(0xffffffff);
  });
});

describe("sniffImageMime", () => {
  test("buffer < 12 bytes → null", () => {
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    expect(sniffImageMime(new Uint8Array(8))).toBeNull();
    expect(sniffImageMime(new Uint8Array(11))).toBeNull();
  });

  test("PNG signature → image/png", () => {
    expect(sniffImageMime(makePngHeader(1, 1))).toBe("image/png");
  });

  test("JPEG (FF D8 FF) → image/jpeg", () => {
    const buf = new Uint8Array(12);
    buf.set([0xff, 0xd8, 0xff, 0xe0], 0);
    expect(sniffImageMime(buf)).toBe("image/jpeg");
  });

  test("WEBP (RIFF....WEBP) → image/webp", () => {
    const buf = new Uint8Array(12);
    buf.set([0x52, 0x49, 0x46, 0x46], 0);
    buf.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMime(buf)).toBe("image/webp");
  });

  test("RIFF without WEBP marker → null", () => {
    const buf = new Uint8Array(12);
    buf.set([0x52, 0x49, 0x46, 0x46], 0);
    buf.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE not WEBP
    expect(sniffImageMime(buf)).toBeNull();
  });

  test("zero buffer → null", () => {
    expect(sniffImageMime(new Uint8Array(12))).toBeNull();
  });

  test("HTML bytes → null", () => {
    expect(sniffImageMime(new TextEncoder().encode("<!DOCTYPE html>"))).toBeNull();
  });

  test("SVG bytes → null", () => {
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns='http'/>"))).toBeNull();
  });
});

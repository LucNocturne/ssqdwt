process.env.KEY_HASH_SECRET ??= "0".repeat(64);
process.env.UPSTREAM_MODE = "mock";
process.env.DB_PATH = ":memory:";

import { beforeAll, describe, expect, test } from "bun:test";

let redactSecrets: (s: string) => string;

beforeAll(async () => {
  const mod = await import("../src/index.ts");
  redactSecrets = mod.redactSecrets;
});

describe("redactSecrets", () => {
  test("redacts Bearer token", () => {
    const s = "401 Unauthorized: Authorization: Bearer sk-cpa-abc123def456ghi789";
    const out = redactSecrets(s);
    expect(out).not.toContain("sk-cpa-abc123def456ghi789");
    expect(out).toMatch(/REDACTED/);
  });

  test("redacts authorization header in JSON-ish body", () => {
    const s = '{"error":"bad","authorization":"Bearer xyz123secrettoken"}';
    const out = redactSecrets(s);
    expect(out).not.toContain("xyz123secrettoken");
  });

  test("redacts api-key= form", () => {
    const s = "request failed api-key=topsecret123 query=foo";
    const out = redactSecrets(s);
    expect(out).not.toContain("topsecret123");
  });

  test("redacts api_key= form", () => {
    const s = "rejected: api_key=anothersecret123";
    const out = redactSecrets(s);
    expect(out).not.toContain("anothersecret123");
  });

  test("redacts standalone sk- token", () => {
    const s = "logged sk-img-customer1234567890abc somewhere in body";
    const out = redactSecrets(s);
    expect(out).not.toContain("sk-img-customer1234567890abc");
    expect(out).toContain("sk-[REDACTED]");
  });

  test("preserves benign content", () => {
    const s = "upstream returned status 502: Bad Gateway";
    expect(redactSecrets(s)).toBe(s);
  });

  test("handles empty string", () => {
    expect(redactSecrets("")).toBe("");
  });
});

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

const DB_PATH = process.env.DB_PATH ?? "./data/gateway.db";

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash        TEXT    NOT NULL UNIQUE,
    key_prefix      TEXT    NOT NULL,
    label           TEXT    NOT NULL DEFAULT '',
    credits_balance INTEGER NOT NULL DEFAULT 0,
    disabled        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id      INTEGER NOT NULL REFERENCES api_keys(id),
    request_id  TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    n           INTEGER NOT NULL,
    status      TEXT    NOT NULL,
    credits     INTEGER NOT NULL,
    latency_ms  INTEGER NOT NULL,
    error       TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage_logs(key_id, created_at);

  CREATE TABLE IF NOT EXISTS recharge_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id     INTEGER NOT NULL REFERENCES api_keys(id),
    delta      INTEGER NOT NULL,
    reason     TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

export type ApiKeyRow = {
  id: number;
  key_hash: string;
  key_prefix: string;
  label: string;
  credits_balance: number;
  disabled: number;
  created_at: number;
};

const SECRET = process.env.KEY_HASH_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error(
    "KEY_HASH_SECRET must be set and >= 32 chars before starting the gateway. " +
      "Generate one with: openssl rand -hex 32",
  );
}

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(SECRET!).update(plain).digest("hex");
}

export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const raw = randomBytes(24).toString("base64url");
  const plain = `sk-img-${raw}`;
  // Display-only prefix: keep just enough to disambiguate ("sk-img-" + 4 chars).
  // Avoid leaking 5+ chars of the random body — see review P2 #7.
  const prefix = `${plain.slice(0, 11)}...`;
  return { plain, prefix, hash: hashApiKey(plain) };
}

export function findKeyByHash(hash: string): ApiKeyRow | null {
  return db
    .query("SELECT * FROM api_keys WHERE key_hash = ? AND disabled = 0")
    .get(hash) as ApiKeyRow | null;
}

export function findKeyById(id: number): ApiKeyRow | null {
  return db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
}

export function createKey(label: string, initialCredits: number) {
  const { plain, prefix, hash } = generateApiKey();
  const now = Date.now();
  const result = db
    .query(
      "INSERT INTO api_keys (key_hash, key_prefix, label, credits_balance, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .get(hash, prefix, label, initialCredits, now) as { id: number };
  if (initialCredits > 0) {
    db.query(
      "INSERT INTO recharge_logs (key_id, delta, reason, created_at) VALUES (?, ?, 'initial', ?)",
    ).run(result.id, initialCredits, now);
  }
  return { id: result.id, plain, prefix, label, credits: initialCredits };
}

export function rechargeKey(keyId: number, delta: number, reason: string): number {
  const tx = db.transaction(() => {
    const row = db
      .query("SELECT credits_balance FROM api_keys WHERE id = ?")
      .get(keyId) as { credits_balance: number } | null;
    if (!row) throw new Error("key not found");
    const newBalance = row.credits_balance + delta;
    if (newBalance < 0) throw new Error("balance would go negative");
    db.query("UPDATE api_keys SET credits_balance = ? WHERE id = ?").run(newBalance, keyId);
    db.query(
      "INSERT INTO recharge_logs (key_id, delta, reason, created_at) VALUES (?, ?, ?, ?)",
    ).run(keyId, delta, reason, Date.now());
    return newBalance;
  });
  return tx();
}

/**
 * 原子预扣:余额 >= cost 才扣。返回 true 表示扣成功。
 * 用 UPDATE ... WHERE credits_balance >= ? 配合 changes 判断。
 */
export function debitCredits(keyId: number, cost: number): boolean {
  const stmt = db.query(
    "UPDATE api_keys SET credits_balance = credits_balance - ? WHERE id = ? AND credits_balance >= ? AND disabled = 0",
  );
  const res = stmt.run(cost, keyId, cost);
  return res.changes === 1;
}

export function refundCredits(keyId: number, amount: number, reason: string): void {
  if (amount <= 0) return;
  const tx = db.transaction(() => {
    db.query("UPDATE api_keys SET credits_balance = credits_balance + ? WHERE id = ?").run(
      amount,
      keyId,
    );
    db.query(
      "INSERT INTO recharge_logs (key_id, delta, reason, created_at) VALUES (?, ?, ?, ?)",
    ).run(keyId, amount, `refund:${reason}`, Date.now());
  });
  tx();
}

export function insertUsageLog(args: {
  keyId: number;
  requestId: string;
  model: string;
  n: number;
  status: "success" | "failed" | "rejected";
  credits: number;
  latencyMs: number;
  error?: string;
}): void {
  db.query(
    `INSERT INTO usage_logs (key_id, request_id, model, n, status, credits, latency_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.keyId,
    args.requestId,
    args.model,
    args.n,
    args.status,
    args.credits,
    args.latencyMs,
    args.error ?? null,
    Date.now(),
  );
}

export function summarizeUsage(keyId?: number) {
  if (keyId !== undefined) {
    return db
      .query(
        `SELECT model, status, COUNT(*) AS count, SUM(credits) AS credits, AVG(latency_ms) AS avg_latency
         FROM usage_logs WHERE key_id = ? GROUP BY model, status`,
      )
      .all(keyId);
  }
  return db
    .query(
      `SELECT key_id, model, status, COUNT(*) AS count, SUM(credits) AS credits
       FROM usage_logs GROUP BY key_id, model, status`,
    )
    .all();
}

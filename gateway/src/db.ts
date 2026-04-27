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

// Schema migration: 0 → 1 (v2 /v1/images/edits 支持 + usage 透传)
// Use BEGIN IMMEDIATE so concurrent gateway boots can't both decide to migrate.
// Inside the transaction we re-check user_version + table_info for idempotency.
{
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === 0) {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info(usage_logs)")
        .all()
        .map((c) => c.name);
      const has = (c: string) => cols.includes(c);
      if (!has("op")) {
        db.exec("ALTER TABLE usage_logs ADD COLUMN op TEXT NOT NULL DEFAULT 'generation'");
      }
      if (!has("input_tokens")) {
        db.exec("ALTER TABLE usage_logs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!has("output_tokens")) {
        db.exec("ALTER TABLE usage_logs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!has("total_tokens")) {
        db.exec("ALTER TABLE usage_logs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!has("usage_json")) {
        db.exec("ALTER TABLE usage_logs ADD COLUMN usage_json TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_usage_op ON usage_logs(op)");
      db.exec("PRAGMA user_version = 1");
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

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

function keyPrefix(plain: string): string {
  return `${plain.slice(0, 11)}...`;
}

export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const raw = randomBytes(24).toString("base64url");
  const plain = `sk-img-${raw}`;
  // Display-only prefix: keep just enough to disambiguate ("sk-img-" + 4 chars).
  // Avoid leaking 5+ chars of the random body — see review P2 #7.
  const prefix = keyPrefix(plain);
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

const ENV_GATEWAY_KEY_CREDITS = 1_000_000_000;

export function configuredGatewayApiKey(): string | null {
  return (
    process.env.GATEWAY_API_KEY?.trim() ||
    process.env.FIXED_API_KEY?.trim() ||
    null
  );
}

export function ensureGatewayApiKeyFromEnv():
  | { id: number; created: boolean; prefix: string; credits: number }
  | null {
  const plain = configuredGatewayApiKey();
  if (!plain) return null;
  if (plain.length < 16) {
    throw new Error("GATEWAY_API_KEY must be at least 16 chars");
  }

  const hash = hashApiKey(plain);
  const prefix = keyPrefix(plain);
  const label = "env-gateway";
  const existing = db
    .query("SELECT id, credits_balance, disabled FROM api_keys WHERE key_hash = ?")
    .get(hash) as { id: number; credits_balance: number; disabled: number } | null;
  if (existing) {
    const targetCredits = Math.max(existing.credits_balance, ENV_GATEWAY_KEY_CREDITS);
    const topup = targetCredits - existing.credits_balance;
    const tx = db.transaction(() => {
      db.query(
        "UPDATE api_keys SET key_prefix = ?, label = ?, disabled = 0, credits_balance = ? WHERE id = ?",
      ).run(prefix, label, targetCredits, existing.id);
      if (topup > 0) {
        db.query(
          "INSERT INTO recharge_logs (key_id, delta, reason, created_at) VALUES (?, ?, 'env-gateway-topup', ?)",
        ).run(existing.id, topup, Date.now());
      }
    });
    tx();
    return {
      id: existing.id,
      created: false,
      prefix,
      credits: targetCredits,
    };
  }

  const now = Date.now();
  const result = db
    .query(
      "INSERT INTO api_keys (key_hash, key_prefix, label, credits_balance, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .get(hash, prefix, label, ENV_GATEWAY_KEY_CREDITS, now) as { id: number };
  db.query(
    "INSERT INTO recharge_logs (key_id, delta, reason, created_at) VALUES (?, ?, 'env-gateway-initial', ?)",
  ).run(result.id, ENV_GATEWAY_KEY_CREDITS, now);
  return { id: result.id, created: true, prefix, credits: ENV_GATEWAY_KEY_CREDITS };
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

export type UsagePayload = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
};

export function insertUsageLog(args: {
  keyId: number;
  requestId: string;
  model: string;
  n: number;
  status: "success" | "failed" | "rejected";
  credits: number;
  latencyMs: number;
  error?: string;
  op?: "generation" | "edit";
  usage?: UsagePayload | null;
}): void {
  const op = args.op ?? "generation";
  const usage = args.usage ?? null;
  db.query(
    `INSERT INTO usage_logs (key_id, request_id, model, n, status, credits, latency_ms, error, created_at,
                             op, input_tokens, output_tokens, total_tokens, usage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    op,
    usage?.input_tokens ?? 0,
    usage?.output_tokens ?? 0,
    usage?.total_tokens ?? 0,
    usage ? JSON.stringify(usage) : null,
  );
}

/** Atomic: debit balance + insert pending usage_logs row in one transaction.
 * Returns logId on success, null on insufficient credits / disabled key. */
export function beginRequest(args: {
  keyId: number;
  cost: number;
  requestId: string;
  model: string;
  n: number;
  op: "generation" | "edit";
}): number | null {
  const tx = db.transaction(() => {
    const debit = db
      .query(
        "UPDATE api_keys SET credits_balance = credits_balance - ? WHERE id = ? AND credits_balance >= ? AND disabled = 0",
      )
      .run(args.cost, args.keyId, args.cost);
    if (debit.changes !== 1) return null;
    const inserted = db
      .query(
        `INSERT INTO usage_logs
           (key_id, request_id, model, n, status, credits, latency_ms, error, created_at,
            op, input_tokens, output_tokens, total_tokens, usage_json)
         VALUES (?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, 0, 0, 0, NULL)
         RETURNING id`,
      )
      .get(
        args.keyId,
        args.requestId,
        args.model,
        args.n,
        args.cost,
        Date.now(),
        args.op,
      ) as { id: number } | null;
    return inserted?.id ?? null;
  });
  return tx();
}

/** Flip pending row to 'success' and stamp tokens + final latency. */
export function completeRequest(args: {
  logId: number;
  latencyMs: number;
  usage?: UsagePayload | null;
}): void {
  const usage = args.usage ?? null;
  db.query(
    `UPDATE usage_logs
        SET status = 'success', latency_ms = ?,
            input_tokens = ?, output_tokens = ?, total_tokens = ?, usage_json = ?
      WHERE id = ?`,
  ).run(
    args.latencyMs,
    usage?.input_tokens ?? 0,
    usage?.output_tokens ?? 0,
    usage?.total_tokens ?? 0,
    usage ? JSON.stringify(usage) : null,
    args.logId,
  );
}

/** Atomic: flip pending → failed + refund balance + insert refund recharge_log. */
export function failRequest(args: {
  logId: number;
  keyId: number;
  cost: number;
  requestId: string;
  latencyMs: number;
  error: string;
}): void {
  const tx = db.transaction(() => {
    db.query(
      "UPDATE usage_logs SET status = 'failed', latency_ms = ?, error = ? WHERE id = ?",
    ).run(args.latencyMs, args.error, args.logId);
    if (args.cost > 0) {
      db.query("UPDATE api_keys SET credits_balance = credits_balance + ? WHERE id = ?").run(
        args.cost,
        args.keyId,
      );
      db.query(
        "INSERT INTO recharge_logs (key_id, delta, reason, created_at) VALUES (?, ?, ?, ?)",
      ).run(args.keyId, args.cost, `refund:${args.requestId}`, Date.now());
    }
  });
  tx();
}

export function summarizeUsage(keyId?: number) {
  if (keyId !== undefined) {
    return db
      .query(
        `SELECT op, model, status, COUNT(*) AS count, SUM(credits) AS credits, AVG(latency_ms) AS avg_latency
         FROM usage_logs WHERE key_id = ? GROUP BY op, model, status`,
      )
      .all(keyId);
  }
  return db
    .query(
      `SELECT key_id, op, model, status, COUNT(*) AS count, SUM(credits) AS credits
       FROM usage_logs GROUP BY key_id, op, model, status`,
    )
    .all();
}

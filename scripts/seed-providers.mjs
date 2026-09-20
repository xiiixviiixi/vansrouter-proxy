// Boot-time provider seed from a Render secret file (or local file).
//
// Problem: Render free tier has no persistent disk, so /app/data (SQLite)
// is wiped on every redeploy/restart, taking provider API keys with it.
//
// Solution: mount a Render Secret File named `provider-seed.json` whose
// content is a Database Backup JSON (Settings → Download Backup). On boot,
// this script imports provider/config tables when the DB is freshly empty.
// It never overwrites an already-configured DB and never touches `settings`
// (dashboard auth stays env-driven via INITIAL_PASSWORD).
//
// Resolution order for the seed file:
//   1. $PROVIDER_SEED_FILE (explicit path)
//   2. /etc/secrets/provider-seed.json (Render secret files at runtime)
//   3. <appRoot>/provider-seed.json (local dev / Docker COPY fallback)
//
// Fail-open by design: any error is logged and boot continues.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CANDIDATES = [
  process.env.PROVIDER_SEED_FILE || "",
  "/etc/secrets/provider-seed.json",
  path.join(APP_ROOT, "provider-seed.json"),
].filter(Boolean);

const SEEDED_TABLES = [
  "providerConnections",
  "providerNodes",
  "proxyPools",
  "apiKeys",
  "combos",
];

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

export async function seedFromSecretFile() {
  const seedPath = CANDIDATES.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!seedPath) {
    console.log("[seed] no seed file found, skipping (set PROVIDER_SEED_FILE or mount /etc/secrets/provider-seed.json)");
    return { seeded: false, reason: "no-seed-file" };
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  } catch (error) {
    console.warn(`[seed] cannot parse ${seedPath}: ${error.message} — skipping`);
    return { seeded: false, reason: "parse-error" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.warn(`[seed] invalid seed payload in ${seedPath} — skipping`);
    return { seeded: false, reason: "invalid-payload" };
  }

  const { getAdapter } = await import("../src/lib/db/driver.js");
  const db = await getAdapter();

  // Never clobber an already-configured DB (e.g. keys added via dashboard
  // after boot). Seed only when both tables are empty = fresh wipe.
  const connCount = db.get(`SELECT COUNT(*) AS n FROM providerConnections`)?.n ?? 0;
  const keyCount = db.get(`SELECT COUNT(*) AS n FROM apiKeys`)?.n ?? 0;
  if (connCount > 0 || keyCount > 0) {
    console.log(`[seed] DB already configured (${connCount} connections, ${keyCount} keys) — skipping ${seedPath}`);
    return { seeded: false, reason: "already-configured" };
  }

  const counts = {};
  db.transaction(() => {
    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    counts.providerConnections = (payload.providerConnections || []).length;

    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    counts.providerNodes = (payload.providerNodes || []).length;

    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    counts.proxyPools = (payload.proxyPools || []).length;

    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }
    counts.apiKeys = (payload.apiKeys || []).length;

    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, context_length, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.context_length ?? null, c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    counts.combos = (payload.combos || []).length;

    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  console.log(`[seed] seeded from ${seedPath}: ${JSON.stringify(counts)}`);
  return { seeded: true, seedPath, counts };
}

// Allow direct execution: `node scripts/seed-providers.mjs`
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  seedFromSecretFile()
    .then((r) => {
      if (!r.seeded) process.exitCode = 0;
    })
    .catch((error) => {
      console.warn(`[seed] failed: ${error?.message || error} — continuing boot`);
    });
}

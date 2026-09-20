// Persistence layer for the live snapshot + source health.
//
// WHY THIS EXISTS: Vercel serverless functions have no shared, durable
// filesystem across invocations or across different api/*.js functions.
// Without this, `loadBase()` always fell back to the static bundled
// data/macro-data.json seed on every single refresh, so change-detection
// ("what changed since yesterday") and source-health history could never
// actually accumulate in production, and different functions could report
// different "last updated" times.
//
// If KV_REST_API_URL / KV_REST_API_TOKEN are set (Vercel KV / Upstash
// Redis integration), we persist real snapshots there. If not, we fall
// back to a per-instance in-memory store and say so honestly everywhere
// persistence status is reported — we never claim durability we don't have.

let kvClient = null;
let kvLoadAttempted = false;

function tryLoadKv() {
  if (kvLoadAttempted) return kvClient;
  kvLoadAttempted = true;
  const configured = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
  if (!configured) return null;
  try {
    const { kv } = require('@vercel/kv');
    kvClient = kv;
  } catch (e) {
    kvClient = null;
  }
  return kvClient;
}

// Per-instance fallback. Only survives within one warm Lambda instance.
const memory = new Map();

function isKvAvailable() {
  return !!tryLoadKv();
}

async function storeGet(key) {
  const kv = tryLoadKv();
  if (kv) {
    try { return await kv.get(key); }
    catch (e) { return memory.has(key) ? memory.get(key) : null; }
  }
  return memory.has(key) ? memory.get(key) : null;
}

async function storeSet(key, value) {
  const kv = tryLoadKv();
  if (kv) {
    try { await kv.set(key, value); return true; }
    catch (e) { memory.set(key, value); return false; }
  }
  memory.set(key, value);
  return false;
}

function persistenceMode() {
  return isKvAvailable() ? 'vercel-kv' : 'in-memory-only (not durable across cold starts — configure KV_REST_API_URL / KV_REST_API_TOKEN for real persistence)';
}

module.exports = { storeGet, storeSet, isKvAvailable, persistenceMode };

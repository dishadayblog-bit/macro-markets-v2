const fs = require('fs');
const path = require('path');
const {
  fetchRBI,
  fetchSEBI,
  fetchMarkets,
  fetchFRED,
  fetchWorldBank,
  fetchNewsRSS,
  buildPayload,
} = require('../src/sources');
const { generateIntelligence } = require('../src/intelligence');
const { storeGet, storeSet, persistenceMode } = require('./_store');

const BASE_FILE = path.join(process.cwd(), 'data', 'macro-data.json');
const SNAPSHOT_KEY = 'macro-markets:snapshot';
const HEALTH_KEY = 'macro-markets:source-health';
const CACHE_TTL_MS = 60 * 1000;
const DEFAULT_SOURCE_TIMEOUT_MS = 30000;

// Per-source budgets: accuracy is more important than shaving seconds.
// The Vercel function allows up to 120s; Markets can legitimately need the
// most time because it validates many instruments across fallback attempts.
const SOURCE_TIMEOUTS = {
  Markets: 75000,
  RBI: 30000,
  SEBI: 30000,
  FRED: 30000,
  'World Bank': 30000,
  News: 30000,
};

let cachedPayload = null;
let cachedAt = 0;
let refreshInFlight = null;

function nowIso() { return new Date().toISOString(); }

function loadSeedFile() {
  try {
    return JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'));
  } catch (e) {
    return {
      updatedAt: nowIso(),
      sourceStatus: 'UNAVAILABLE',
      sections: {},
      changes: [],
      sources: [],
      dataQuality: { liveSections: [], staleSections: [], warnings: [e.message] },
    };
  }
}

// Prefer the last persisted live snapshot; fall back to the static bundled
// seed only when nothing has been persisted yet.
async function loadBase() {
  const persisted = await storeGet(SNAPSHOT_KEY);
  if (persisted && persisted.sections) return persisted;
  return loadSeedFile();
}

function withSourceTimeout(promise, label) {
  const ms = SOURCE_TIMEOUTS[label] || DEFAULT_SOURCE_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true, errors: [`${label} refresh timeout after ${ms}ms`] }), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function snapshotDashboard(payload) {
  const s = payload.sections || {};
  const markets = s['indian-markets']?.assets || [];
  const globalMarkets = s['global-markets'] || {};
  const rbi = s['rbi-watch']?.stories || [];
  const sebi = s['sebi-watch']?.stories || [];
  const geo = s['geopolitics-markets']?.stories || [];

  const marketRows = [
    ...markets.slice(0, 2),
    ...(globalMarkets.bonds || []).slice(0, 1),
    ...(globalMarkets.commodities || []).slice(0, 1),
    ...(globalMarkets.currencies || []).slice(0, 1),
  ].filter(Boolean).slice(0, 5).map(x => ({ name: x.name, level: x.level, change: x.change }));

  const liveStories = [...rbi, ...sebi, ...geo]
    .filter(x => x && x.title)
    .slice(0, 8)
    .map(x => ({
      priority: x.priority || 'watch',
      title: x.title,
      why: x.why || x.whatHappened || '',
      section: x.source === 'SEBI' ? 'sebi-watch' : /RBI/i.test(x.source || '') ? 'rbi-watch' : 'geopolitics-markets',
    }));

  // Never replace the curated analyst dashboard. Add live data alongside it.
  const existing = s.dashboard || {};
  payload.sections.dashboard = {
    ...existing,
    updatedAt: payload.updatedAt,
    liveAvailable: true,
    liveUpdates: {
      markets: marketRows,
      stories: liveStories,
      checkedAt: payload.updatedAt,
      sources: payload.sources || [],
    },
  };
}

async function safeSource(label, promiseFactory) {
  const startedAt = Date.now();
  try {
    const result = await withSourceTimeout(
      Promise.resolve().then(promiseFactory),
      label,
    );
    const usable = Object.keys(result?.data || {}).length > 0 ||
      Object.keys(result?.globalQuotes?.data || {}).length > 0 ||
      (result?.stories || []).length > 0 ||
      (result?.items || []).length > 0 ||
      Object.keys(result || {}).some(k => ['flows', 'indicators'].includes(k));
    const ok = !result?.__timeout && usable;
    const error = result?.__timeout
      ? (result.errors || [`${label} refresh timeout`])[0]
      : (result?.errors || [])[0] || null;
    await recordSourceHealth(label, { ok, latencyMs: Date.now() - startedAt, error });
    return result;
  } catch (error) {
    await recordSourceHealth(label, {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error.message || String(error),
    });
    return {
      data: {},
      globalQuotes: { data: {} },
      stories: [],
      items: [],
      errors: [`${label}: ${error.message || String(error)}`],
      source: label,
    };
  }
}

async function recordSourceHealth(label, { ok, latencyMs, error }) {
  try {
    const health = (await storeGet(HEALTH_KEY)) || {};
    const at = nowIso();
    health[label] = {
      status: ok ? 'HEALTHY' : 'FAILING',
      lastSuccess: ok ? at : (health[label]?.lastSuccess || null),
      lastFailure: ok ? (health[label]?.lastFailure || null) : at,
      lastError: ok ? null : (error || 'Unknown error'),
      latencyMs,
      checkedAt: at,
    };
    await storeSet(HEALTH_KEY, health);
  } catch (e) {
    // Health tracking must never break the actual refresh.
  }
}

async function fetchSourceSet() {
  const [rbi, sebi, markets, fred, worldbank, news] = await Promise.all([
    safeSource('RBI', () => fetchRBI()),
    safeSource('SEBI', () => fetchSEBI()),
    safeSource('Markets', () => fetchMarkets()),
    safeSource('FRED', () => fetchFRED(process.env.FRED_API_KEY)),
    safeSource('World Bank', () => fetchWorldBank()),
    safeSource('News', () => fetchNewsRSS(process.env.NEWS_RSS_URLS || '')),
  ]);
  return { rbi, sebi, markets, fred, worldbank, news };
}

async function buildLivePayload({ includeAI = false, mode = 'live' } = {}) {
  const base = await loadBase();
  let sourceSet;
  try {
    sourceSet = await fetchSourceSet();
  } catch (error) {
    sourceSet = {
      rbi: { stories: [], sources: [], errors: [`RBI: ${error.message || String(error)}`] },
      sebi: { stories: [], source: 'SEBI', errors: [] },
      markets: { data: {}, errors: [`Markets: ${error.message || String(error)}`] },
      fred: { data: {}, errors: [`FRED: ${error.message || String(error)}`] },
      worldbank: { data: {}, errors: [`World Bank: ${error.message || String(error)}`] },
      news: { stories: [], sources: [], errors: [`News: ${error.message || String(error)}`] },
    };
  }
  let payload;
  try {
    payload = buildPayload(base, sourceSet, new Date());
  } catch (error) {
    payload = JSON.parse(JSON.stringify(base));
    payload.updatedAt = nowIso();
    payload.sourceStatus = 'LIVE / PARTIAL';
    payload.dataQuality = payload.dataQuality || { liveSections: [], staleSections: [], warnings: [] };
    payload.dataQuality.warnings = [...(payload.dataQuality.warnings || []), `Payload build: ${error.message || String(error)}`];
    payload.changes = Array.isArray(payload.changes) ? payload.changes : [];
  }
  payload.refreshRun = { mode, startedAt: payload.updatedAt, completedAt: nowIso(), generatedBy: 'Macro & Markets live ingestion', timeoutPolicy: SOURCE_TIMEOUTS };
  payload.persistence = persistenceMode();
  payload.sourceHealth = (await storeGet(HEALTH_KEY)) || {};
  snapshotDashboard(payload);

  // AI is opt-in so a manual refresh cannot fail or time out because of an LLM request.
  if (includeAI && process.env.OPENAI_API_KEY) {
    try {
      const intelligence = await generateIntelligence(payload);
      if (intelligence?.deepDive) {
        payload.sections['deep-dive'] = { ...(payload.sections['deep-dive'] || {}), updatedAt: payload.updatedAt, liveAvailable: true, source: 'OpenAI', story: intelligence.deepDive };
      }
      if (Array.isArray(intelligence?.interviewQuestions) && intelligence.interviewQuestions.length) {
        payload.sections['interview-prep'] = { ...(payload.sections['interview-prep'] || {}), updatedAt: payload.updatedAt, liveAvailable: true, source: 'OpenAI', questions: intelligence.interviewQuestions };
      }
      if (Array.isArray(intelligence?.sectorInsights) && intelligence.sectorInsights.length) {
        payload.sections['sector-performance'] = { ...(payload.sections['sector-performance'] || {}), updatedAt: payload.updatedAt, liveAvailable: true, source: 'OpenAI', sectors: intelligence.sectorInsights };
      }
      if (Array.isArray(intelligence?.companyInsights) && intelligence.companyInsights.length) {
        payload.sections['top-companies'] = { ...(payload.sections['top-companies'] || {}), updatedAt: payload.updatedAt, liveAvailable: true, source: 'OpenAI', companies: intelligence.companyInsights };
      }
      payload.aiStatus = intelligence.error ? 'fallback' : 'ready';
      if (intelligence.error) payload.dataQuality.warnings.push(`AI layer: ${intelligence.error}`);
    } catch (e) {
      payload.aiStatus = 'fallback';
      payload.dataQuality.warnings.push(`AI layer: ${e.message}`);
    }
  } else {
    payload.aiStatus = process.env.OPENAI_API_KEY ? 'available' : 'not-configured';
  }

  await storeSet(SNAPSHOT_KEY, payload);
  return payload;
}

async function getCachedLive() {
  if (cachedPayload && Date.now() - cachedAt < CACHE_TTL_MS) return cachedPayload;
  if (!refreshInFlight) {
    refreshInFlight = buildLivePayload({ includeAI: false, mode: 'live-read' })
      .then(p => { cachedPayload = p; cachedAt = Date.now(); return p; })
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh() {
  if (!refreshInFlight) {
    refreshInFlight = buildLivePayload({ includeAI: false, mode: 'manual-or-cron' })
      .then(p => { cachedPayload = p; cachedAt = Date.now(); return p; })
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * Validate that a cron/refresh request is authorized.
 * Returns true if authorized, false otherwise.
 */
function isRefreshAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // No secret configured = allow all (development mode)
  
  // Check Authorization header
  const authHeader = req.headers?.authorization || '';
  if (authHeader === `Bearer ${secret}`) return true;
  
  // Check query parameter
  const url = req.url || '';
  if (url.includes(`secret=${encodeURIComponent(secret)}`)) return true;
  
  // Check x-vercel-cron-signature or x-cron-secret header
  if (req.headers?.['x-cron-secret'] === secret) return true;
  
  return false;
}

module.exports = { loadBase, loadSeedFile, getCachedLive, doRefresh, buildLivePayload, isRefreshAuthorized };

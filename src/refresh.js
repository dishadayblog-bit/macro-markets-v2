/**
 * Refresh runner for local development server.
 * 
 * This is the local-dev equivalent of the Vercel API service layer.
 * It reads/writes to the filesystem instead of KV.
 * 
 * In production (Vercel), api/_service.js handles all of this.
 */

const fs = require('fs');
const path = require('path');
const { fetchRBI, fetchSEBI, fetchMarkets, fetchFRED, fetchWorldBank, fetchNewsRSS, buildPayload } = require('./sources');
const { generateIntelligence } = require('./intelligence');

const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'macro-data.json'));
const HISTORY_FILE = path.resolve(process.env.HISTORY_FILE || path.join(__dirname, '..', 'data', 'refresh-history.json'));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function hash(obj) { const crypto = require('crypto'); return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }

function compareSection(a, b, section) {
  if (!b) return null;
  if (!a && b.liveAvailable) return { type: 'NEW', section, title: `Live data added: ${section}`, summary: 'A new live section became available.' };
  if (!b.liveAvailable) return null;
  if (hash(a) !== hash(b)) return { type: 'CHANGED', section, title: `Updated: ${section}`, summary: 'The latest live payload differs from the previous stored snapshot.' };
  return null;
}

function detectChanges(previous, next) {
  const changes = [];
  for (const section of Object.keys(next.sections || {})) {
    const c = compareSection(previous?.sections?.[section], next.sections?.[section], section);
    if (c) changes.push({ ...c, timestamp: next.updatedAt });
  }
  for (const c of (next.changes || [])) changes.push({ ...c, timestamp: c.timestamp || next.updatedAt });
  const seen = new Set();
  return changes.filter(c => { const k = [c.type, c.section, c.title].join('|'); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 50);
}

async function runRefresh({ mode = 'scheduled' } = {}) {
  const startedAt = new Date();
  const previous = readJson(DATA_FILE, { sections: {}, changes: [] });

  // Fetch all sources in parallel with individual error isolation
  const [rbi, sebi, markets, fred, worldbank, news] = await Promise.allSettled([
    fetchRBI(),
    fetchSEBI(),
    fetchMarkets(),
    fetchFRED(process.env.FRED_API_KEY || ''),
    fetchWorldBank(),
    fetchNewsRSS(process.env.NEWS_RSS_URLS || ''),
  ]);

  const unwrap = (result, fallback) => result.status === 'fulfilled' ? result.value : { ...fallback, errors: [result.reason?.message || String(result.reason)] };

  const sourceSet = {
    rbi: unwrap(rbi, { stories: [], sources: [], errors: [] }),
    sebi: unwrap(sebi, { stories: [], source: 'SEBI', errors: [] }),
    markets: unwrap(markets, { data: {}, globalQuotes: { data: {} }, errors: [] }),
    fred: unwrap(fred, { data: {}, errors: [] }),
    worldbank: unwrap(worldbank, { data: {}, errors: [] }),
    news: unwrap(news, { stories: [], sources: [], errors: [] }),
  };

  let next = buildPayload(previous, sourceSet, new Date());
  next.changes = detectChanges(previous, next);
  next.aiStatus = 'generating';
  writeJson(DATA_FILE, next);

  // AI is opt-in
  if (process.env.OPENAI_API_KEY) {
    try {
      const intelligence = await generateIntelligence(next);
      next.sections.dashboard = {
        ...(next.sections.dashboard || {}),
        ...(intelligence.dashboard || {}),
        updatedAt: next.updatedAt,
        liveAvailable: true,
        source: 'Aggregated live sources + AI analysis',
      };
      if (intelligence.deepDive) next.sections['deep-dive'] = { updatedAt: next.updatedAt, liveAvailable: true, source: intelligence.generatedBy || 'AI', story: intelligence.deepDive };
      next.sections['interview-prep'] = { updatedAt: next.updatedAt, liveAvailable: true, source: intelligence.generatedBy || 'AI', questions: intelligence.interviewQuestions || [] };
      if (intelligence.sectorInsights?.length) next.sections['sector-performance'] = { ...(next.sections['sector-performance'] || {}), updatedAt: next.updatedAt, liveAvailable: true, source: intelligence.generatedBy || 'AI', sectors: intelligence.sectorInsights };
      if (intelligence.companyInsights?.length) next.sections['top-companies'] = { ...(next.sections['top-companies'] || {}), updatedAt: next.updatedAt, liveAvailable: true, source: intelligence.generatedBy || 'AI', companies: intelligence.companyInsights };
      if (intelligence.error) next.dataQuality.warnings.push(`AI layer: ${intelligence.error}`);
      next.aiStatus = intelligence.error ? 'fallback' : (intelligence.generatedBy || 'ready');
    } catch (e) {
      next.aiStatus = 'fallback';
      next.dataQuality.warnings.push(`AI layer: ${e.message}`);
    }
  } else {
    next.aiStatus = 'not-configured';
  }

  next.dataQuality.liveSections = Object.entries(next.sections).filter(([, v]) => v?.liveAvailable).map(([k]) => k);
  next.dataQuality.staleSections = Object.entries(next.sections).filter(([, v]) => v?.liveAvailable === false).map(([k]) => k);
  next.sourceMaterial = {
    fetchedAt: next.updatedAt,
    storyCount: [...(sourceSet.rbi.stories || []), ...(sourceSet.sebi.stories || []), ...(sourceSet.news.stories || [])].length,
    marketCount: Object.keys(sourceSet.markets.data || {}).length,
    fredCount: Object.keys(sourceSet.fred.data || {}).length,
    worldBankCount: Object.keys(sourceSet.worldbank.data || {}).length,
  };
  next.refreshRun = { mode, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime() };
  writeJson(DATA_FILE, next);

  const history = readJson(HISTORY_FILE, []);
  history.unshift({
    startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), mode, status: 'completed',
    liveSections: next.dataQuality.liveSections || [], warnings: next.dataQuality.warnings || [], changes: next.changes.length, aiStatus: next.aiStatus,
  });
  writeJson(HISTORY_FILE, history.slice(0, 100));
  return next;
}

module.exports = { runRefresh };

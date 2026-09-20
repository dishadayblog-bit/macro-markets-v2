/**
 * Local development server for Macro & Markets Intelligence.
 * 
 * This server replicates the Vercel API routes for local development.
 * It uses the same service layer (_service.js equivalent) but reads/writes
 * to the local filesystem instead of Vercel KV.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { runRefresh } = require('./refresh');

const PORT = Number(process.env.PORT || 8787);
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'macro-data.json'));
const HISTORY_FILE = path.resolve(process.env.HISTORY_FILE || path.join(__dirname, '..', 'data', 'refresh-history.json'));
const FRONTEND_FILE = path.resolve(__dirname, '..', 'public', 'index.html');
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function send(res, status, body, type = 'application/json; charset=utf-8') { res.writeHead(status, { 'Content-Type': type, ...corsHeaders, 'Cache-Control': 'no-store' }); res.end(body); }
function json(res, status, obj) { send(res, status, JSON.stringify(obj, null, 2)); }
function serveFrontend(res) { try { send(res, 200, fs.readFileSync(FRONTEND_FILE, 'utf8'), 'text/html; charset=utf-8'); } catch (e) { json(res, 500, { error: 'Frontend unavailable', details: e.message }); } }

let refreshRunning = false;

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) return serveFrontend(res);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'macro-markets-backend', time: new Date().toISOString(), refreshRunning });
  }

  if (req.method === 'GET' && url.pathname === '/api/macro-data') {
    return json(res, 200, readJson(DATA_FILE, { error: 'Data unavailable' }));
  }

  if (req.method === 'GET' && url.pathname === '/api/refresh-history') {
    return json(res, 200, readJson(HISTORY_FILE, []));
  }

  if (req.method === 'GET' && url.pathname === '/api/source-status') {
    const p = readJson(DATA_FILE, {});
    return json(res, 200, {
      updatedAt: p.updatedAt, sourceStatus: p.sourceStatus, aiStatus: p.aiStatus || 'not-run',
      sources: p.sources || [], sourceMaterial: p.sourceMaterial || null,
      dataQuality: p.dataQuality || {}, refreshRun: p.refreshRun || null,
    });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/section/')) {
    const id = url.pathname.replace('/api/section/', '');
    const p = readJson(DATA_FILE, { sections: {} });
    const section = p.sections?.[id];
    if (!section) return json(res, 404, { error: `Section not found: ${id}` });
    return json(res, 200, section);
  }

  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    if (refreshRunning) return json(res, 409, { ok: false, error: 'Refresh already running' });
    refreshRunning = true;
    try {
      const payload = await runRefresh({ mode: 'manual' });
      return json(res, 200, { ok: true, updatedAt: payload.updatedAt, sourceStatus: payload.sourceStatus, dataQuality: payload.dataQuality, changes: payload.changes });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    finally { refreshRunning = false; }
  }

  return json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Macro & Markets backend running at http://localhost:${PORT}`));

// Server-side schedule: 07:00 and 19:00 Asia/Kolkata
let lastRunKey = '';
setInterval(() => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  const hm = `${get('hour')}:${get('minute')}`;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const key = `${date}|${hm}`;
  if ((hm === '07:00' || hm === '19:00') && key !== lastRunKey && !refreshRunning) {
    lastRunKey = key;
    refreshRunning = true;
    runRefresh({ mode: 'scheduled' }).catch(console.error).finally(() => { refreshRunning = false; });
  }
}, 30000);

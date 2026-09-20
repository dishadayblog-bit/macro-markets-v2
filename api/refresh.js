const { doRefresh, isRefreshAuthorized } = require('./_service');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  // Only allow GET (for cron) and POST (for manual refresh)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cron protection: verify secret when configured
  if (!isRefreshAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized — provide CRON_SECRET in Authorization header' });
  }

  try {
    const payload = await doRefresh();
    return res.status(200).json({
      ok: true,
      updatedAt: payload.updatedAt,
      sourceStatus: payload.sourceStatus,
      dataQuality: payload.dataQuality,
      changes: payload.changes?.length || 0,
      persistence: payload.persistence,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};

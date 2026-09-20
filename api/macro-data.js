const { getCachedLive, doRefresh } = require('./_service');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).end();
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const rawUrl = req.url || '';
    const force = /(?:^|[?&])force=1(?:&|$)/.test(rawUrl);
    const payload = force ? await doRefresh() : await getCachedLive();
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json(await getCachedLive().catch(() => ({
      updatedAt: new Date().toISOString(),
      sourceStatus: 'FALLBACK',
      sections: {},
      changes: [],
      dataQuality: { liveSections: [], staleSections: [], warnings: [e.message || String(e)] },
    })));
  }
};

const { getCachedLive, loadSeedFile } = require('./_service');

module.exports = async function handler(_req, res) {
  try {
    const payload = await getCachedLive();
    return res.status(200).json({
      status: payload.sourceStatus || 'LIVE / PARTIAL',
      sources: payload.sources || [],
      liveSections: payload.dataQuality?.liveSections || [],
      staleSections: payload.dataQuality?.staleSections || [],
      warnings: payload.dataQuality?.warnings || [],
      checkedAt: payload.updatedAt || new Date().toISOString(),
      persistence: payload.persistence || 'unknown',
      sourceHealth: payload.sourceHealth || {},
    });
  } catch (e) {
    const base = loadSeedFile();
    return res.status(200).json({
      status: base.sourceStatus || 'FALLBACK',
      sources: base.sources || [],
      liveSections: base.dataQuality?.liveSections || [],
      staleSections: base.dataQuality?.staleSections || [],
      warnings: [e.message, ...(base.dataQuality?.warnings || [])],
      checkedAt: base.updatedAt || new Date().toISOString(),
      persistence: 'unknown',
      sourceHealth: {},
    });
  }
};

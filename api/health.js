module.exports = async function handler(_req, res) {
  res.status(200).json({
    ok: true,
    service: 'macro-markets',
    mode: 'vercel-functions',
    time: new Date().toISOString(),
  });
};

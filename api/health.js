module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    service: 'betbetter',
    node: process.version,
    ts: new Date().toISOString(),
  });
};

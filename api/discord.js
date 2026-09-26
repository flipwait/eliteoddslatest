module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { webhookUrl, content, embeds, components } = body;
  const url = webhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return res.status(400).json({ error: 'webhookUrl or DISCORD_WEBHOOK_URL required' });

  try {
    const payload = {
      content: content || undefined,
      embeds: embeds || undefined,
      components: components || undefined,
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: t });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

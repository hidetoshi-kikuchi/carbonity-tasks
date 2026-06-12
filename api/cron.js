// api/cron.js - 毎朝8時（JST）に自動実行されるCronジョブ

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisGet(key) {
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const d = await r.json();
    if (!d.result) return null;
    const v = typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
    return v;
  } catch(e) { return null; }
}

async function redisSet(key, val) {
  const value = JSON.stringify(val);
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SLACK_TOKEN       = process.env.SLACK_TOKEN;

  try {
    // 前回スキャン日時を取得（なければ1日前）
    const lastScanAt = await redisGet('carbonity:lastScanAt');
    const since = lastScanAt

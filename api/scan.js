// api/scan.js - Vercel Serverless Function
// Slackスキャン + Claude抽出 + Upstash Redis でデータ永続化

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

// ── Redis helpers ──
async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}
async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SLACK_TOKEN       = process.env.SLACK_TOKEN;

  // ── GET: データ取得 ──
  if (req.method === 'GET') {
    try {
      const tasks   = await redisGet('carbonity:tasks')   || [];
      const history = await redisGet('carbonity:history') || [];
      return res.status(200).json({ tasks, history });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST /api/scan?action=save: ステータス保存 ──
  if (req.method === 'POST' && req.query.action === 'save') {
    try {
      const { tasks, history } = req.body;
      await redisSet('carbonity:tasks',   JSON.stringify(tasks   || []));
      await redisSet('carbonity:history', JSON.stringify(history || []));
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST /api/scan: Slackスキャン ──
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ANTHROPIC_API_KEY || !SLACK_TOKEN) return res.status(500).json({ error: '環境変数が未設定です' });

  try {
    // Slack検索
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const afterDate = since.toISOString().split('T')[0];

    const slackRes = await fetch(
      `https://slack.com/api/search.messages?query=after:${afterDate}&count=100&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const slackData = await slackRes.json();
    if (!slackData.ok) return res.status(500).json({ error: `Slack: ${slackData.error}` });

    const messages = (slackData.messages?.matches || []).map(m => ({
      channel:   m.channel?.name || '',
      user:      m.username || m.user || '',
      text:      (m.text || '').slice(0, 300),
      permalink: m.permalink || ''
    }));

    if (!messages.length) return res.status(200).json({ tasks: [], scannedAt: new Date().toISOString(), messageCount: 0 });

    // Claude抽出
    const msgDump = messages.map(m => `[#${m.channel}] ${m.user}: ${m.text}`).join('\n');
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `Slackメッセージからタスク・依頼・宿題・アクションアイテムを抽出し、JSON配列のみ返してください（説明不要）:
[{"text":"内容(60文字以内)","channel":"チャンネル名","assignee":"担当者(不明は空)","due":"YYYY-MM-DD(なければ空)","link":"URLまたは空"}]
なければ[]`,
        messages: [{ role: 'user', content: `今日は${new Date().toLocaleDateString('ja-JP')}。\n\n${msgDump}` }]
      })
    });
    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const match = rawText.match(/\[[\s\S]*\]/);
    const newTasks = match ? JSON.parse(match[0]) : [];

    // 既存データとマージして保存
    const existing = await redisGet('carbonity:tasks') || [];
    let added = 0;
    for (const item of newTasks) {
      if (!existing.find(t => t.text.slice(0, 20) === (item.text || '').slice(0, 20))) {
        const maxId = existing.length ? Math.max(...existing.map(t => t.id || 0)) : 0;
        existing.push({ id: maxId + 1, ...item, status: 'todo', createdAt: new Date().toISOString() });
        added++;
      }
    }
    await redisSet('carbonity:tasks', JSON.stringify(existing));

    return res.status(200).json({ tasks: newTasks, scannedAt: new Date().toISOString(), messageCount: messages.length, added });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

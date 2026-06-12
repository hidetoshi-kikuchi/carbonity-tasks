// api/scan.js - Vercel Serverless Function
// Slackスキャン + Claude抽出 + Upstash Redis でデータ永続化

const REDIS_URL   = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

// ── Upstash Redis REST helpers ──
async function redisGet(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    const val = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
    return val;
  } catch(e) {
    console.error('redisGet error:', e);
    return null;
  }
}

async function redisSet(key, arr) {
  const value = JSON.stringify(arr);
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
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
      const tasks      = (await redisGet('carbonity:tasks'))   || [];
      const history    = (await redisGet('carbonity:history')) || [];
      const lastScanAt = (await redisGet('carbonity:lastScanAt')) || null;
      return res.status(200).json({ tasks, history, lastScanAt });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── POST ?action=save: ステータス保存 ──
  if (req.query && req.query.action === 'save') {
    try {
      const { tasks, history } = req.body || {};
      await redisSet('carbonity:tasks',   tasks   || []);
      await redisSet('carbonity:history', history || []);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST /api/scan: Slackスキャン ──
  if (!ANTHROPIC_API_KEY || !SLACK_TOKEN) {
    return res.status(500).json({ error: '環境変数 ANTHROPIC_API_KEY または SLACK_TOKEN が未設定です' });
  }

  try {
    // 前回スキャン日時を取得（なければ7日前）
    const lastScanAt = await redisGet('carbonity:lastScanAt');
    const since = lastScanAt
      ? new Date(lastScanAt)
      : (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })();
    const afterDate = since.toISOString().split('T')[0];

    console.log(`Scanning from: ${afterDate} (lastScanAt: ${lastScanAt || 'none'})`);

    // Slack検索
    const slackRes = await fetch(
      `https://slack.com/api/search.messages?query=after:${afterDate}&count=100&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const slackData = await slackRes.json();
    if (!slackData.ok) return res.status(500).json({ error: `Slack APIエラー: ${slackData.error}` });

    const messages = (slackData.messages?.matches || []).map(m => ({
      channel:   m.channel?.name || '',
      user:      m.username || m.user || '',
      text:      (m.text || '').slice(0, 300),
      permalink: m.permalink || ''
    }));

    // スキャン日時を今すぐ保存（次回はここから）
    const nowIso = new Date().toISOString();
    await redisSet('carbonity:lastScanAt', nowIso);

    if (!messages.length) {
      return res.status(200).json({
        tasks: [], scannedAt: nowIso, messageCount: 0, added: 0,
        since: afterDate
      });
    }

    // Claudeでタスク抽出
    const msgDump = messages.map(m => `[#${m.channel}] ${m.user}: ${m.text}`).join('\n');
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `Slackメッセージからタスク・依頼・宿題・アクションアイテムを全て抽出し、JSON配列のみ返してください（説明不要）:
[{"text":"内容(60文字以内)","channel":"チャンネル名(#なし)","assignee":"担当者(不明は空文字)","due":"YYYY-MM-DD(なければ空文字)","link":"SlackURLまたは空文字"}]
タスクなし→[]`,
        messages: [{ role: 'user', content: `今日は${new Date().toLocaleDateString('ja-JP')}。\n\n${msgDump}` }]
      })
    });
    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const match = rawText.match(/\[[\s\S]*\]/);
    const newTasks = match ? JSON.parse(match[0]) : [];

    // 既存データとマージ（テキストの先頭20文字で重複チェック）
    const existing = (await redisGet('carbonity:tasks')) || [];
    let added = 0;
    for (const item of newTasks) {
      const isDup = existing.some(t => (t.text||'').slice(0,20) === (item.text||'').slice(0,20));
      if (!isDup) {
        const maxId = existing.length ? Math.max(...existing.map(t => t.id || 0)) : 0;
        existing.push({
          id: maxId + 1,
          text: item.text || '',
          channel: item.channel || '',
          assignee: item.assignee || '',
          due: item.due || '',
          link: item.link || '',
          status: 'todo',
          createdAt: nowIso
        });
        added++;
      }
    }
    await redisSet('carbonity:tasks', existing);

    return res.status(200).json({
      tasks: newTasks,
      scannedAt: nowIso,
      messageCount: messages.length,
      added,
      since: afterDate
    });

  } catch (err) {
    console.error('scan error:', err);
    return res.status(500).json({ error: err.message });
  }
}

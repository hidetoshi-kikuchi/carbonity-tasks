// api/cron.js - 毎朝8時（JST）に自動実行されるCronジョブ

export default async function handler(req, res) {
  // Vercelの認証チェック
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SLACK_TOKEN       = process.env.SLACK_TOKEN;
  const REDIS_URL         = process.env.KV_REST_API_URL;
  const REDIS_TOKEN       = process.env.KV_REST_API_TOKEN;

  // ── Redis helpers ──
  async function redisGet(key) {
    try {
      const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const d = await r.json();
      if (!d.result) return null;
      const v = typeof d.result === 'string' ? JSON.parse(d.result) : d.result;
      return Array.isArray(v) ? v : null;
    } catch(e) { return null; }
  }
  async function redisSet(key, arr) {
    const value = JSON.stringify(arr);
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  }

  try {
    // Slack検索（直近30日）
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const afterDate = since.toISOString().split('T')[0];

    const slackRes = await fetch(
      `https://slack.com/api/search.messages?query=after:${afterDate}&count=100&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const slackData = await slackRes.json();
    if (!slackData.ok) throw new Error(`Slack: ${slackData.error}`);

    const messages = (slackData.messages?.matches || []).map(m => ({
      channel: m.channel?.name || '',
      user:    m.username || m.user || '',
      text:    (m.text || '').slice(0, 300),
      permalink: m.permalink || ''
    }));

    if (!messages.length) {
      return res.status(200).json({ ok: true, added: 0, messageCount: 0 });
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

    // 既存データとマージ
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
          createdAt: new Date().toISOString()
        });
        added++;
      }
    }
    await redisSet('carbonity:tasks', existing);

    console.log(`Cron scan complete: ${added} tasks added from ${messages.length} messages`);
    return res.status(200).json({
      ok: true,
      added,
      messageCount: messages.length,
      scannedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}

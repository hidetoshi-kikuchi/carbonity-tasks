const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  const val = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  return val;
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: fetch current tasks
  if (req.method === 'GET') {
    try {
      const tasks = await redisGet('carbonity:tasks') || [];
      const history = await redisGet('carbonity:history') || [];
      const lastScanAt = await redisGet('carbonity:lastScanAt');
      return res.status(200).json({ tasks, history, lastScanAt });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST?action=save: save task state
  if (req.method === 'POST' && req.query.action === 'save') {
    try {
      const { tasks, history } = req.body;
      await redisSet('carbonity:tasks', tasks || []);
      await redisSet('carbonity:history', history || []);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST: scan Slack and extract tasks
  if (req.method === 'POST') {
    try {
      const SLACK_TOKEN = process.env.SLACK_TOKEN;
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

      // Get last scan time for incremental scanning
      const lastScanAt = await redisGet('carbonity:lastScanAt');
      const now = new Date();
      const scanFromDate = lastScanAt ? new Date(lastScanAt) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const afterDate = scanFromDate.toISOString().split('T')[0];

      // Get all channels
      const chRes = await fetch('https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200', {
        headers: { Authorization: `Bearer ${SLACK_TOKEN}` }
      });
      const chData = await chRes.json();
      if (!chData.ok) throw new Error('Slack channel list failed: ' + chData.error);

      const channels = chData.channels || [];
      let allMessages = [];

      // Search messages in each channel since last scan
      for (const ch of channels) {
        try {
          const query = `after:${afterDate}`;
          const msgRes = await fetch(
            `https://slack.com/api/search.messages?query=${encodeURIComponent(query + ' in:#' + ch.name)}&count=20`,
            { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
          );
          const msgData = await msgRes.json();
          if (msgData.ok && msgData.messages && msgData.messages.matches) {
            for (const m of msgData.messages.matches) {
              allMessages.push({ channel: ch.name, text: m.text, ts: m.ts });
            }
          }
        } catch (e) {
          // skip channel on error
        }
      }

      if (allMessages.length === 0) {
        return res.status(200).json({ added: 0, message: 'No new messages found' });
      }

      // Use Claude to extract tasks
      const prompt = `以下のSlackメッセージからタスク・TODO・依頼事項を抽出してください。
各タスクについて以下のJSON配列形式で返してください：
[{"task":"タスク内容","channel":"チャンネル名","due":"期限(YYYY-MM-D形式、不明な場合はnull)","assignee":"担当者名(不明な場合はnull)"}]

タスクが見つからない場合は空配列 [] を返してください。
JSONのみ返してください。

メッセージ:
${allMessages.map(m => `[#${m.channel}] ${m.text}`).join('\n').slice(0, 8000)}`;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-5-5',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const claudeData = await claudeRes.json();
      if (!claudeData.content || !claudeData.content[0]) {
        throw new Error('Claude API error: ' + JSON.stringify(claudeData));
      }

      let extracted = [];
      try {
        const text = claudeData.content[0].text.trim();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          extracted = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {
        extracted = [];
      }

      // Merge with existing tasks (avoid duplicates)
      const existing = await redisGet('carbonity:tasks') || [];
      const history = await redisGet('carbonity:history') || [];

      let added = 0;
      for (const item of extracted) {
        const isDuplicate = existing.some(e => e.task === item.task && e.channel === item.channel) ||
                            history.some(h => h.task === item.task && h.channel === item.channel);
        if (!isDuplicate) {
          existing.push({
            id: Date.now() + Math.random(),
            task: item.task,
            channel: item.channel || '',
            due: item.due || null,
            assignee: item.assignee || null,
            status: 'todo',
            createdAt: now.toISOString()
          });
          added++;
        }
      }

      await redisSet('carbonity:tasks', existing);
      await redisSet('carbonity:lastScanAt', now.toISOString());

      return res.status(200).json({ added, total: existing.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

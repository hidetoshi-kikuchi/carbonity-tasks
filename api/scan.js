// api/scan.js  –  Vercel Serverless Function
// Slackの全チャンネルをスキャンしてClaudeでタスク抽出

export default async function handler(req, res) {
  // CORS（ブラウザからのアクセスを許可）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const SLACK_TOKEN       = process.env.SLACK_TOKEN;

  if (!ANTHROPIC_API_KEY || !SLACK_TOKEN) {
    return res.status(500).json({ error: '環境変数が設定されていません' });
  }

  try {
    // ── Step 1: Slackから直近1ヶ月のメッセージを検索 ──
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const afterDate = since.toISOString().split('T')[0].replace(/-/g, '-');

    const slackRes = await fetch(
      `https://slack.com/api/search.messages?query=after:${afterDate}&count=100&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const slackData = await slackRes.json();

    if (!slackData.ok) {
      return res.status(500).json({ error: `Slack APIエラー: ${slackData.error}` });
    }

    // メッセージを整形
    const messages = (slackData.messages?.matches || []).map(m => ({
      channel: m.channel?.name || '',
      user:    m.username || m.user || '',
      text:    m.text?.slice(0, 300) || '',
      ts:      m.ts,
      permalink: m.permalink || ''
    }));

    if (messages.length === 0) {
      return res.status(200).json({ tasks: [], scannedAt: new Date().toISOString() });
    }

    // ── Step 2: Claudeでタスク抽出 ──
    const msgDump = messages
      .map(m => `[#${m.channel}] ${m.user}: ${m.text}`)
      .join('\n');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            ANTHROPIC_API_KEY,
        'anthropic-version':    '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: `あなたはSlackメッセージからタスクを抽出するアシスタントです。
以下のメッセージ一覧を分析し、タスク・依頼・宿題・アクションアイテムを全て抽出してください。
必ずJSON配列のみを返してください（説明・マークダウン不要）:
[{"text":"タスク内容（日本語60文字以内）","channel":"チャンネル名(#なし)","assignee":"担当者名(不明は空)","due":"YYYY-MM-DD(なければ空)","link":"SlackURLまたは空"}]
タスクなし→空配列[]`,
        messages: [{
          role:    'user',
          content: `今日は${new Date().toLocaleDateString('ja-JP')}です。以下のSlackメッセージからタスクを抽出してください:\n\n${msgDump}`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    const tasks = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    return res.status(200).json({
      tasks,
      scannedAt:    new Date().toISOString(),
      messageCount: messages.length
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

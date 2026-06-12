// api/cron.js - 毎朝8時（JST）に自動実行されるCronジョブ
// Vercel Cron Jobs から呼び出される

export default async function handler(req, res) {
  // Vercelの認証チェック（不正アクセス防止）
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // /api/scan を内部呼び出し（POSTリクエスト）
    const baseUrl = `https://${req.headers.host}`;
    const scanRes = await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await scanRes.json();

    if (data.error) {
      console.error('Cron scan error:', data.error);
      return res.status(500).json({ error: data.error });
    }

    console.log(`Cron scan complete: ${data.added} tasks added from ${data.messageCount} messages`);
    return res.status(200).json({
      ok: true,
      added: data.added,
      messageCount: data.messageCount,
      scannedAt: data.scannedAt
    });

  } catch (err) {
    console.error('Cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}

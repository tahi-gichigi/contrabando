// /api/cron/poll-and-reply — Vercel Cron endpoint (runs hourly)
// Polls GBP for new unreplied reviews, generates and posts replies.
// Secured with CRON_SECRET header.

import { run, pingHeartbeat } from '../../../lib/pipeline.js';
import { sendAlert } from '../../../lib/notify.js';

export default async function handler(req, res) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Ping Better Stack at the start of the cron, and AWAIT it so the request
  // actually flushes before the function returns. This proves the cron fired
  // regardless of how the pipeline run turns out (a fast failure used to drop a
  // fire-and-forget ping), and keeps the ping timing locked to the schedule.
  await pingHeartbeat(process.env.BETTERSTACK_HEARTBEAT_URL);

  try {
    const result = await run();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] poll-and-reply error:', err);
    // Alert on cron endpoint failure (pipeline.run already alerts on unhandled exceptions,
    // but catch here in case the error is thrown before pipeline.run gets to fire its alert)
    sendAlert(`Cron endpoint /api/cron/poll-and-reply failed:\n${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}

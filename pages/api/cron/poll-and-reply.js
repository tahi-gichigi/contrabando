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

  const heartbeatUrl = process.env.BETTERSTACK_HEARTBEAT_URL;

  try {
    const result = await run();
    // Signal a healthy beat ONLY after the run actually completes, so a pipeline
    // that crashes every hour can't keep the monitor green. Awaited so the ping
    // is delivered before the function freezes on return.
    await pingHeartbeat(heartbeatUrl);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron] poll-and-reply error:', err);
    // Alert on cron endpoint failure (pipeline.run already alerts on unhandled exceptions,
    // but catch here in case the error is thrown before pipeline.run gets to fire its alert)
    sendAlert(`Cron endpoint /api/cron/poll-and-reply failed:\n${err.message}`).catch(() => {});
    // Actively report the failure so Better Stack opens an incident now instead
    // of waiting for the heartbeat to time out. A hard crash (OOM / function
    // timeout) sends no ping at all and is caught by the missed-beat timeout.
    await pingHeartbeat(heartbeatUrl, { fail: true });
    return res.status(500).json({ error: err.message });
  }
}

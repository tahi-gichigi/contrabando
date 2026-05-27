// ui/lib/pipeline.js — poll-and-reply pipeline (ES module for Vercel Cron)
// State is stored in Neon Postgres (dedicated to this project via Vercel integration).
// Without DATABASE_URL, logs a warning and starts fresh each run.

import { fetchAllNewReviews, fetchSingleReview, postReply, LOCATIONS } from './gbp.js';
import { sendWhatsApp, sendAlert } from './notify.js';

// Safety cap: never process more than this many reviews in a single run.
// Prevents a state reset from triggering mass-replies to hundreds of old reviews.
const MAX_REPLIES_PER_RUN = 20;

// --- Language detection ---
// GBP returns "(Translated by Google) ..." before "(Original) ..." for non-English reviews.
// We strip the translation and detect on the original text only.
// Edge case: sometimes GBP returns only "(Translated by Google) ..." with no "(Original)" marker.
// In that case we can't recover the original — return '' so generateReply() uses the raw text.
function stripGoogleTranslation(text) {
  if (!text) return text;

  // Has both markers — extract original text after "(Original)"
  const originalMatch = text.match(/\(Original\)\s*\n?([\s\S]*)/i);
  if (originalMatch) return originalMatch[1].trim();

  // Has translation prefix but no "(Original)" — we only have the EN translation, not the original
  if (/^\(Translated by Google\)/i.test(text.trim())) return '';

  // Native text, no markers
  return text;
}

// detectLanguage() removed - language detection is now handled by the model
// inside generateReply(). The regex approach was brittle and misclassified
// PT reviews containing English brand names (e.g. "the fork") or shared
// PT/ES vocabulary.

// --- State via Neon Postgres (dedicated to this project via Vercel integration) ---
// Table: contrabando_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)
// DATABASE_URL is auto-injected by Vercel's Neon integration.
const STATE_KEY = 'contrabando:poll-state';

async function queryNeon(sql, params = []) {
  const { neon } = await import('@neondatabase/serverless');
  const sql_fn = neon(process.env.DATABASE_URL);
  return sql_fn(sql, params);
}

// Fresh state factory — repliedReviewIds is now an object keyed by location name
function freshState() {
  return { lastPollTime: new Date().toISOString(), repliedReviewIds: {} };
}

async function loadState() {
  if (!process.env.DATABASE_URL) {
    console.warn('[pipeline] No DATABASE_URL — state NOT persisted. Starting from now.');
    return freshState();
  }
  try {
    const rows = await queryNeon(
      'SELECT value FROM contrabando_state WHERE key = $1',
      [STATE_KEY]
    );
    if (rows && rows.length > 0) {
      const state = rows[0].value;

      // Migration: old flat array → per-location object.
      // Existing IDs are assigned to Almada (the only location before this change).
      if (Array.isArray(state.repliedReviewIds)) {
        const almadaName = LOCATIONS[0].name; // Almada is index 0
        console.log(`[pipeline] Migrating flat repliedReviewIds (${state.repliedReviewIds.length} IDs) to per-location format`);
        state.repliedReviewIds = { [almadaName]: state.repliedReviewIds };
      }

      return state;
    }
  } catch (err) {
    console.warn('[pipeline] State load failed:', err.message);
  }
  return freshState();
}

async function saveState(state) {
  if (!process.env.DATABASE_URL) {
    console.warn('[pipeline] No DATABASE_URL — state NOT saved.');
    return;
  }
  try {
    await queryNeon(
      `INSERT INTO contrabando_state (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [STATE_KEY, JSON.stringify(state)]
    );
  } catch (err) {
    console.warn('[pipeline] State save failed:', err.message);
  }
}

// --- Reply generation ---
// OpenAI client and guidelines loaded once per run, not per reply
let _openaiClient = null;
let _systemPrompt = null;

function getOpenAIClient() {
  if (!_openaiClient) {
    const OpenAI = require('openai').default || require('openai');
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiClient;
}

function getSystemPrompt() {
  if (!_systemPrompt) {
    const fs = require('fs');
    const path = require('path');
    // On Vercel the cwd is the ui/ directory where tone-of-voice-guidelines.md lives
    const guidelinesPath = path.join(process.cwd(), 'tone-of-voice-guidelines.md');
    const guidelines = fs.readFileSync(guidelinesPath, 'utf8');
    // Return JSON with language detection folded into the reply call.
    // This replaces the brittle regex detectLanguage() - the model is far better
    // at identifying language in reviews that mix brand names or English loanwords.
    _systemPrompt = `${guidelines}\n\n---\nIMPORTANT: You must return valid JSON only. No markdown, no code fences, no explanation.\nFormat: {"lang": "<ISO 639-1 two-letter code, uppercase>", "reply": "<the reply text>"}\n\nThe "lang" field is the language of the ORIGINAL review (not the reply). Use PT, EN, ES, FR, or IT. If unsure, default to PT.\nThe "reply" field is the reply text as it should appear on Google.`;
  }
  return _systemPrompt;
}

// Generate a reply and detect language in one model call.
// Returns { lang: 'PT'|'EN'|'ES'|'FR'|'IT', reply: string }
// The model determines language from the review text directly, replacing the
// old regex-based detectLanguage() which misclassified PT reviews containing
// English brand names like "the fork".
async function generateReply(starRating, reviewText) {
  const client = getOpenAIClient();
  // Strip Google translation before sending to the model - we want it to see
  // the original text, not the machine-translated English version.
  const cleanText = stripGoogleTranslation(reviewText || '') || reviewText || '(no comment)';
  const response = await client.responses.create({
    model: 'gpt-5-mini',
    instructions: getSystemPrompt(),
    input: `Star rating: ${starRating}\nReview text: ${cleanText}`,
    reasoning: { effort: 'minimal' }
  });

  // Parse the JSON response. Fall back to PT + raw text if the model
  // returns something unexpected.
  const raw = response.output_text.trim();
  try {
    const parsed = JSON.parse(raw);
    const VALID_LANGS = ['PT', 'EN', 'ES', 'FR', 'IT'];
    const lang = VALID_LANGS.includes(parsed.lang) ? parsed.lang : 'PT';
    const reply = (parsed.reply || '').trim();
    if (!reply) throw new Error('empty reply field');
    return { lang, reply };
  } catch {
    // Model didn't return valid JSON - use raw text as the reply, default to PT
    console.warn('[pipeline] Model returned non-JSON, falling back to PT:', raw.slice(0, 100));
    return { lang: 'PT', reply: raw };
  }
}

// --- Main pipeline ---
export async function run({ dryRun = false } = {}) {
  // Wrap everything in a top-level try/catch to fire an alert on unhandled exceptions
  try {
    return await _run({ dryRun });
  } catch (err) {
    console.error('[pipeline] Unhandled exception:', err.message);
    // Fire-and-forget alert — don't let the alert failure mask the original error
    sendAlert(`Unhandled exception in poll-and-reply:\n${err.message}`).catch(() => {});
    throw err;
  }
}

async function _run({ dryRun = false } = {}) {
  // Warn loudly if no Supabase key in production — cron will be a no-op
  if (!process.env.DATABASE_URL && process.env.VERCEL) {
    console.error('[pipeline] WARNING: No DATABASE_URL configured. State will not persist between runs. Pipeline is a no-op until key is set.');
  }

  const state = await loadState();
  const totalTracked = Object.values(state.repliedReviewIds).reduce((sum, ids) => sum + ids.length, 0);
  console.log(`[pipeline] Last poll: ${state.lastPollTime}, tracking ${totalTracked} replied reviews across ${Object.keys(state.repliedReviewIds).length} locations`);

  // Token refresh failure should alert immediately — don't silently miss all reviews
  let newReviews;
  try {
    // Apply a 2-hour lookback buffer: GBP API can propagate reviews with a delay,
    // so we poll slightly behind lastPollTime to catch late-appearing reviews.
    // The repliedReviewIds dedup prevents double-posting anything we already replied to.
    const pollSince = state.lastPollTime
      ? new Date(new Date(state.lastPollTime).getTime() - 2 * 60 * 60 * 1000).toISOString()
      : state.lastPollTime;
    newReviews = await fetchAllNewReviews(pollSince);
  } catch (err) {
    const isTokenError = err.message.includes('Token refresh failed') || err.message.includes('env vars not set');
    if (isTokenError) {
      await sendAlert(`GBP token refresh failed — OAuth re-auth may be needed.\n${err.message}`);
    }
    throw err;
  }
  console.log(`[pipeline] ${newReviews.length} new reviews since last poll`);

  // Filter unreplied — check per-location ID lists
  const unreplied = newReviews.filter(r => {
    const locIds = state.repliedReviewIds[r.locationName] || [];
    return !r.reviewReply && !locIds.includes(r.reviewId);
  });
  console.log(`[pipeline] ${unreplied.length} unreplied`);

  // Safety cap: if we somehow have more than MAX_REPLIES_PER_RUN unreplied, process in batches
  if (unreplied.length > MAX_REPLIES_PER_RUN) {
    console.warn(`[pipeline] WARNING: ${unreplied.length} unreplied reviews exceeds cap of ${MAX_REPLIES_PER_RUN}. Processing first ${MAX_REPLIES_PER_RUN} only. Run again to process more.`);
  }
  const toProcess = unreplied.slice(0, MAX_REPLIES_PER_RUN);

  let replied = 0;
  let errors = 0;

  for (const review of toProcess) {
    const { starRating, reviewer, comment, reviewId, locationName, locationLabel } = review;
    const reviewName = `${locationName}/reviews/${reviewId}`;

    // Helper to record a review ID in per-location state
    const markReplied = (rid, locName) => {
      if (!state.repliedReviewIds[locName]) state.repliedReviewIds[locName] = [];
      state.repliedReviewIds[locName].push(rid);
    };

    try {
      // Language detection is now folded into the model call - no more regex.
      const { lang, reply } = await generateReply(starRating, comment);
      console.log(`  [${locationLabel}] ★${starRating} [${lang}] ${reviewer}: "${(comment || '').slice(0, 60)}"`);
      console.log(`  → "${reply}"`);

      if (!dryRun) {
        // Double-check: re-fetch this review to confirm it still has no reply before posting.
        // Guards against race conditions or manual replies added between our fetch and post.
        const current = await fetchSingleReview(reviewName);
        if (current && current.reviewReply) {
          console.log(`  [skip] Review ${reviewId} already has a reply (added since fetch) — skipping`);
          markReplied(reviewId, locationName);
          await saveState(state);
          continue;
        }

        const result = await postReply(reviewName, reply);
        if (result.error) throw new Error(JSON.stringify(result.error));

        // Atomic state save: persist after each successful reply, not just at the end.
        // If the process crashes mid-batch, we won't re-reply to already-replied reviews.
        markReplied(reviewId, locationName);
        await saveState(state);

        replied++;

        // Include location label in WhatsApp alert for low ratings
        if (starRating <= 2) await sendWhatsApp(starRating, reviewer, comment, locationLabel);
      } else {
        replied++;
      }
    } catch (err) {
      console.error(`  [error] [${locationLabel}] ${err.message}`);
      errors++;
    }
  }

  // Cap repliedReviewIds per location to prevent unbounded growth
  for (const locName of Object.keys(state.repliedReviewIds)) {
    if (state.repliedReviewIds[locName].length > 500) {
      state.repliedReviewIds[locName] = state.repliedReviewIds[locName].slice(-500);
    }
  }

  state.lastPollTime = new Date().toISOString();
  if (!dryRun) await saveState(state);

  const result = { processed: unreplied.length, replied, errors };

  // Alert if the run completed with errors
  if (errors > 0) {
    await sendAlert(`Pipeline run completed with ${errors} error(s).\nProcessed: ${unreplied.length}, Replied: ${replied}, Errors: ${errors}`).catch(() => {});
  }

  return result;
}

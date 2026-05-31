// pipeline.test.js - tests for pipeline pure functions
// Run with: node lib/pipeline.test.js
// No test framework needed - just node.

// --- Mirror of stripGoogleTranslation from pipeline.js ---
function stripGoogleTranslation(text) {
  if (!text) return text;
  const originalMatch = text.match(/\(Original\)\s*\n?([\s\S]*)/i);
  if (originalMatch) return originalMatch[1].trim();
  if (/^\(Translated by Google\)/i.test(text.trim())) return '';
  return text;
}

// --- Mirror of JSON parsing logic from generateReply ---
// Extracted as a pure function so we can test it without calling OpenAI.
// This is the exact same logic used in pipeline.js generateReply().
function parseModelResponse(raw) {
  try {
    const parsed = JSON.parse(raw);
    const VALID_LANGS = ['PT', 'EN', 'ES', 'FR', 'IT'];
    const lang = VALID_LANGS.includes(parsed.lang) ? parsed.lang : 'PT';
    const reply = (parsed.reply || '').trim();
    if (!reply) throw new Error('empty reply field');
    return { lang, reply };
  } catch {
    return { lang: 'PT', reply: raw.trim() };
  }
}

let passed = 0;
let failed = 0;

function expect(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected "${expected}", got "${actual}"`);
    failed++;
  }
}

function expectObj(label, actual, expected) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// =============================================
// stripGoogleTranslation() tests
// =============================================
console.log('\nstripGoogleTranslation()');

expect(
  'returns native PT text unchanged',
  stripGoogleTranslation('A comida estava muito boa'),
  'A comida estava muito boa'
);

expect(
  'extracts original from full GBP format',
  stripGoogleTranslation('(Translated by Google) The food was great\n(Original)\nA comida estava ótima'),
  'A comida estava ótima'
);

expect(
  'returns empty string when only translation prefix, no Original marker',
  stripGoogleTranslation('(Translated by Google) The food and service were impeccable'),
  ''
);

expect('handles null', stripGoogleTranslation(null), null);
expect('handles empty string', stripGoogleTranslation(''), '');

// Regression: Gabriela Leote case - PT review mentioning "the fork"
// GBP wraps this in translation markers. stripGoogleTranslation extracts the PT original.
expect(
  'Gabriela Leote: extracts PT original from review mentioning "the fork"',
  stripGoogleTranslation('(Translated by Google) Good food, good service. Booked through the fork.\n(Original)\nBoa comida, bom serviço. Reservei pelo the fork.'),
  'Boa comida, bom serviço. Reservei pelo the fork.'
);

// When GBP only has the translated version (no Original marker), strip returns ''
// so the model gets the raw text as fallback and detects language itself
expect(
  'Gabriela Leote variant: translation-only with "the fork" returns empty',
  stripGoogleTranslation('(Translated by Google) Great experience, booked via the fork'),
  ''
);

// =============================================
// parseModelResponse() tests - JSON parsing
// =============================================
console.log('\nparseModelResponse()');

expectObj(
  'valid JSON with PT lang',
  parseModelResponse('{"lang": "PT", "reply": "Obrigado pela visita!"}'),
  { lang: 'PT', reply: 'Obrigado pela visita!' }
);

expectObj(
  'valid JSON with EN lang',
  parseModelResponse('{"lang": "EN", "reply": "Thank you for your visit!"}'),
  { lang: 'EN', reply: 'Thank you for your visit!' }
);

expectObj(
  'valid JSON with ES lang',
  parseModelResponse('{"lang": "ES", "reply": "Gracias por su visita!"}'),
  { lang: 'ES', reply: 'Gracias por su visita!' }
);

expectObj(
  'valid JSON with FR lang',
  parseModelResponse('{"lang": "FR", "reply": "Merci pour votre visite!"}'),
  { lang: 'FR', reply: 'Merci pour votre visite!' }
);

expectObj(
  'valid JSON with IT lang',
  parseModelResponse('{"lang": "IT", "reply": "Grazie per la visita!"}'),
  { lang: 'IT', reply: 'Grazie per la visita!' }
);

// Invalid/unknown lang falls back to PT
expectObj(
  'unknown lang code falls back to PT',
  parseModelResponse('{"lang": "DE", "reply": "Danke!"}'),
  { lang: 'PT', reply: 'Danke!' }
);

expectObj(
  'missing lang field falls back to PT',
  parseModelResponse('{"reply": "Obrigado!"}'),
  { lang: 'PT', reply: 'Obrigado!' }
);

// Non-JSON fallback: model returns plain text
expectObj(
  'plain text fallback returns PT + raw text',
  parseModelResponse('Obrigado pela visita!'),
  { lang: 'PT', reply: 'Obrigado pela visita!' }
);

// Empty reply field triggers fallback
expectObj(
  'empty reply field triggers fallback',
  parseModelResponse('{"lang": "PT", "reply": ""}'),
  { lang: 'PT', reply: '{"lang": "PT", "reply": ""}' }
);

// Markdown-wrapped JSON (model sometimes does this)
expectObj(
  'markdown-wrapped JSON triggers plain text fallback',
  parseModelResponse('```json\n{"lang": "PT", "reply": "Obrigado!"}\n```'),
  { lang: 'PT', reply: '```json\n{"lang": "PT", "reply": "Obrigado!"}\n```' }
);

// =============================================
// Regression cases - language detection scenarios
// These document the cases that the old regex got wrong.
// With model-based detection, these are handled by the LLM,
// but we test that the JSON parsing correctly surfaces whatever
// lang the model returns.
// =============================================
console.log('\nRegression cases (JSON parsing preserves model lang)');

// Gabriela Leote case: PT review with "the fork" - model should return PT
// We simulate what the model would return for this case
expectObj(
  'Gabriela Leote: model returns PT for review with "the fork"',
  parseModelResponse('{"lang": "PT", "reply": "Obrigado! Ficamos contentes que tenha gostado."}'),
  { lang: 'PT', reply: 'Obrigado! Ficamos contentes que tenha gostado.' }
);

// Ana Filipa case: short PT review with shared PT/ES words
expectObj(
  'Ana Filipa: model returns PT for "Boa comida, bom ambiente"',
  parseModelResponse('{"lang": "PT", "reply": "Obrigado pelo feedback! Até à próxima."}'),
  { lang: 'PT', reply: 'Obrigado pelo feedback! Até à próxima.' }
);

// Mixed language review where model correctly identifies dominant language
expectObj(
  'mixed PT/EN review: model returns PT',
  parseModelResponse('{"lang": "PT", "reply": "Obrigado! Esperamos vê-lo novamente."}'),
  { lang: 'PT', reply: 'Obrigado! Esperamos vê-lo novamente.' }
);

// =============================================
// pingHeartbeat() tests
// The heartbeat must be DELIVERED, not fire-and-forget. On Vercel's
// serverless runtime an un-awaited fetch can be killed when the handler
// returns, dropping the ping → Better Stack flags a missed heartbeat →
// DOWN, then the next hour's ping auto-resolves it. These tests pin the
// "ping is awaited" contract so the regression can't come back.
// =============================================
console.log('\npingHeartbeat()');

async function runAsyncTests() {
  const { pingHeartbeat } = await import('./pipeline.js');

  // No URL configured → no fetch attempted, resolves false.
  {
    let called = false;
    const fakeFetch = () => { called = true; return Promise.resolve(); };
    const result = await pingHeartbeat('', fakeFetch);
    expect('skips when url is empty (returns false)', result, false);
    expect('does not call fetch when url is empty', called, false);
  }

  // URL configured → fetch called with that URL.
  {
    let seenUrl = null;
    const fakeFetch = (u) => { seenUrl = u; return Promise.resolve(); };
    await pingHeartbeat('https://uptime.example/hb/abc', fakeFetch);
    expect('calls fetch with the heartbeat url', seenUrl, 'https://uptime.example/hb/abc');
  }

  // THE REGRESSION TEST: pingHeartbeat must AWAIT the fetch. We resolve the
  // fetch on a later microtask and flip a flag in its .then(). If the ping
  // were fire-and-forget, pingHeartbeat would return before that flag flips.
  {
    let fetchSettled = false;
    const fakeFetch = () =>
      Promise.resolve().then(() => Promise.resolve()).then(() => { fetchSettled = true; });
    await pingHeartbeat('https://uptime.example/hb/abc', fakeFetch);
    expect('awaits the fetch before resolving (delivery guaranteed)', fetchSettled, true);
  }

  // A failing ping must never throw / never break the cron.
  {
    const fakeFetch = () => Promise.reject(new Error('network down'));
    let threw = false;
    try {
      await pingHeartbeat('https://uptime.example/hb/abc', fakeFetch);
    } catch {
      threw = true;
    }
    expect('swallows fetch errors (never throws)', threw, false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runAsyncTests();

// health_metrics.supplements is the EFFECTIVE list of supplements/medications taken on a day:
// what the user typed in Dietetyk (supplements_manual) plus what they ticked as "Taken" in
// the Apple Health Medications list (supplements_apple, derived by
// utils/appleHealthEvents.js), with duplicates removed.
//
// Why a merged column rather than teaching every reader about two sources: about eight
// places read `supplements` (Dashboard advice and its 7-day history, the
// supplements-sleep insight, the AI explanation, weekly/monthly summaries, the PDF report).
// Keeping the merged value in the column they already read makes all of them see Health
// medications with no change to any of them, and makes "the same magnesium logged in both
// places" count once everywhere, not just in the places someone remembered to dedupe.

// Matches the length cap of POST /api/supplements (routes/health.js), so the merged value
// can never exceed what a reader of the column has always been able to receive.
const MAX_SUPPLEMENTS_LENGTH = 2000;

function parseList(text) {
  return (text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function normalize(name) {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// "Magnez" typed by hand and "Magnez 400 mg" from Health are the same supplement; "Witamina
// D3" and "Witamina C" are not. Same = equal, or one is the other plus extra words (dose,
// form) - a whole-word prefix, so "witamina" alone does not swallow every vitamin... except
// that it does when the user literally typed just "witamina", which is ambiguous anyway.
function sameSupplement(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return longer.startsWith(`${shorter} `);
}

/**
 * Manual entries first, in the user's own wording; Health entries appended unless a manual
 * one already covers them.
 */
function mergeSupplements(manualText, appleText) {
  const merged = [...parseList(manualText)];
  for (const item of parseList(appleText)) {
    if (!merged.some((m) => sameSupplement(m, item))) merged.push(item);
  }
  if (merged.length === 0) return null;
  return merged.join(', ').slice(0, MAX_SUPPLEMENTS_LENGTH);
}

/** Rewrites health_metrics.supplements for one day from its two sources. */
async function recomputeSupplements(db, userId, date) {
  const row = await db.get(
    'SELECT supplements_manual, supplements_apple FROM health_metrics WHERE user_id = ? AND date = ?',
    [userId, date]
  );
  if (!row) return null;
  const merged = mergeSupplements(row.supplements_manual, row.supplements_apple);
  await db.run(
    'UPDATE health_metrics SET supplements = ? WHERE user_id = ? AND date = ?',
    [merged, userId, date]
  );
  return merged;
}

module.exports = {
  MAX_SUPPLEMENTS_LENGTH,
  mergeSupplements,
  recomputeSupplements,
  sameSupplement,
  parseList
};

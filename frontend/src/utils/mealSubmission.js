// One idempotency key per submission of the meal form, re-used when the SAME submission is
// retried (audit 2026-10-09, W2 - see the meal_submissions migration in backend/db.js).
//
// A retry is "the same meal again": same text, same date, same photo. The key survives a
// failed attempt (a dropped connection, a 504, a 409 "still analysing") and is dropped only
// once the server confirmed the save, so the next, genuinely new meal gets a new key. Pure, so
// mealSubmission.test.js can pin the rules down.

export function mealFingerprint(rawText, date, imageBase64) {
  const image = imageBase64 || '';
  return JSON.stringify([String(rawText || '').trim(), date || '', image.length, image.slice(-64)]);
}

// `previous` is the { fingerprint, key } kept from the last unconfirmed attempt, or null.
export function submissionKeyFor(previous, fingerprint, makeId) {
  if (previous && previous.fingerprint === fingerprint) return previous;
  return { fingerprint, key: makeId() };
}

export function randomSubmissionId() {
  const { crypto } = globalThis;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure context; plain-HTTP development falls back to the same entropy.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

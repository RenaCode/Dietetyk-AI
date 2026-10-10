// Idempotency keys for POST /api/meals (audit 2026-10-09, W2 - see the meal_submissions
// migration in backend/db.js).
//
// A key identifies one SUBMISSION, never the meal's content. The first version reused the key
// whenever the same text/date/photo was sent again after an unconfirmed attempt (audit round
// 2): a meal whose request dropped but was saved, then deliberately added a second time the
// same day, came back "replayed" with a success message - and no second entry. Text, date and
// photo cannot tell a retry from a second portion; only the user can. So every press of "Add"
// is a new submission with a new key, and the old key is re-sent only through the explicit
// "retry" action offered after an unconfirmed attempt. Pure, so mealSubmission.test.js can
// pin the rule down.

// A new submission: always a new key, whatever the content.
export function newMealSubmission(rawText, date, imageBase64, makeId = randomSubmissionId) {
  return { key: makeId(), rawText, date, imageBase64 };
}

// The submission to re-send on "retry": the same object, so the same key - the server then
// answers with what the first attempt saved instead of saving it again.
export function retryMealSubmission(pending) {
  if (!pending || !pending.key) throw new Error('retryMealSubmission: nothing to retry');
  return pending;
}

export function randomSubmissionId() {
  const { crypto } = globalThis;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure context; plain-HTTP development falls back to the same entropy.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

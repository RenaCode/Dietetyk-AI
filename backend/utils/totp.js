const { generateSecret, generateSync, verifySync, generateURI, createGuardrails } = require('otplib');
const db = require('../db');

// Every TOTP call in the backend goes through this module, so the parameters below are the
// one place that decides whether the codes on users' phones still match.
//
// otplib 13 (10.2026) replaced the v12 `authenticator` object with plain functions, and two
// of its defaults would have locked every enrolled user out without an error anyone sees:
//
// - Secrets shorter than 16 bytes throw SecretTooShortError. Every secret stored before the
//   upgrade came from v12's authenticator.generateSecret(), which made 10 bytes (16 base32
//   characters). LEGACY_GUARDRAILS lowers the minimum to 10 bytes, so those secrets keep
//   verifying. New secrets are 20 bytes (RFC 4226's recommendation, v13's default).
// - The parameters are spelled out rather than left to the library: SHA-1, 6 digits, a
//   30-second step and no tolerance window (v12's authenticator ran with window 0). Changing
//   any of them makes the codes of existing authenticator apps wrong.
//
// tests/test-totp-compat.js holds codes produced by otplib 12 for fixed secrets and times,
// and checks that this module still accepts them.
const TOTP_OPTIONS = Object.freeze({ algorithm: 'sha1', digits: 6, period: 30 });
const LEGACY_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 10 });
const NEW_SECRET_BYTES = 20;
const ISSUER = 'Dietetyk AI';

function newTotpSecret() {
  return generateSecret({ length: NEW_SECRET_BYTES });
}

// otpauth:// URI for the QR code. v13 leaves out parameters equal to the defaults above,
// which is how authenticator apps read a URI without them.
function totpKeyUri(label, secret) {
  return generateURI({ issuer: ISSUER, label, secret, ...TOTP_OPTIONS });
}

// The code for `secret` at `epochSeconds` (now by default). Used by tests in place of what an
// authenticator app would show.
function totpCode(secret, epochSeconds) {
  return generateSync({
    secret,
    ...TOTP_OPTIONS,
    guardrails: LEGACY_GUARDRAILS,
    ...(epochSeconds === undefined ? {} : { epoch: epochSeconds })
  });
}

// The time step a code matches, or null. Throws nothing: a malformed code (wrong length,
// letters) or a malformed secret is just "no match", as checkDelta returned null in v12.
function matchingTimeStep(secret, code, epochSeconds) {
  try {
    const result = verifySync({
      secret,
      token: code,
      ...TOTP_OPTIONS,
      epochTolerance: 0,
      guardrails: LEGACY_GUARDRAILS,
      ...(epochSeconds === undefined ? {} : { epoch: epochSeconds })
    });
    return result.valid ? result.timeStep : null;
  } catch {
    return null;
  }
}

// Verifies a TOTP code AND burns it: a code is accepted at most once per user.
//
// A bare "is this code valid right now" check let the same six digits work for every request
// inside their 30-second step. A code seen once - over a shoulder, or relayed by a real-time
// phishing page that logs in in parallel with the victim - was a second login, or a second
// enrolment of a fresh 2FA setup.
//
// The step that matched is stored in users.totp_last_step and anything at or below it is
// refused. The UPDATE carries the comparison itself (`totp_last_step < ?`), so two parallel
// requests with the same code cannot both win: SQLite runs the statement atomically and only
// one of them changes the row. The step is the RFC 6238 counter, floor(unix seconds / 30) -
// the same number v12 produced, so values stored before the upgrade still compare correctly.
async function verifyTotpOnce(userId, secret, code) {
  if (!secret || (typeof code !== 'string' && typeof code !== 'number')) return false;
  const step = matchingTimeStep(secret, String(code).trim());
  if (step === null || step === undefined) return false;

  const result = await db.run(
    `UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
    [step, userId, step]
  );
  return result.changes === 1;
}

module.exports = { verifyTotpOnce, newTotpSecret, totpKeyUri, totpCode, matchingTimeStep, TOTP_OPTIONS };

const { totpCode, TOTP_OPTIONS } = require('../../utils/totp');

// The current TOTP code for `secret`, taken only when at least `marginMs` of its 30-second
// step is left.
//
// The server accepts a code in its own step only (window 0 - see utils/totp.js), so a test
// that generates a code and sends it straight away fails whenever the step changes in
// between. It did: the CI run of #62 generated a code at hh:mm:29.98 and the server checked
// it at hh:mm:30.13. Waiting out the tail of the step costs at most `marginMs`, and every
// request the caller sends within that margin sees the same step - which also keeps a code
// chosen to be WRONG (different from this one) from becoming the right one mid-test.
//
// The clock is not frozen instead: otplib reads Date.now() itself and verifyTotpOnce takes
// no time argument, so faking it would mean patching the code under test.
async function freshTotpCode(secret, marginMs = 2000) {
  const stepMs = TOTP_OPTIONS.period * 1000;
  const leftMs = stepMs - (Date.now() % stepMs);
  if (leftMs <= marginMs) {
    await new Promise((resolve) => setTimeout(resolve, leftMs + 100));
  }
  return totpCode(secret);
}

module.exports = { freshTotpCode };

const express = require('express');
const router = express.Router();
const { getActiveShareByToken } = require('../services/sharedReports');
const { buildHealthReportPdf } = require('../services/pdfReport');

// Public, UNAUTHENTICATED endpoint for retrieving a shared PDF report (product feature:
// share a report by link, read-only). The recipient (a doctor or dietician) has no
// account in the app, so session/Bearer authentication does not apply. Instead the token
// in the URL itself (see services/sharedReports.js) uniquely identifies both the user and
// the specific share.
//
// This router MUST therefore be mounted in app.js BEFORE `app.use('/api', requireAuth)`,
// like routes/healthcheck.js and routes/appleHealth.js. The path starts with
// `/api/public/` (rather than `/api/user/...` like the rest of account.js) so that the URL
// alone makes it obvious this endpoint is public by design, not by an overlooked missing
// autoryzacji.
//
// The rate limiter (apiRateLimiter in app.js) is mounted on '/api' BEFORE this
// router, so it still covers this route - which matters, because the token is the only
// access barrier and the limiter makes guessing or brute-forcing it much harder.
// Per-link limit on PDF generation. Building the PDF reads up to 180 days of data and lays it
// out with pdfkit - the heaviest anonymous request the app serves - and the only brake was the
// global limiter, which in this cluster is one bucket for everybody (see app.js). One leaked
// link polled in a loop therefore cost real CPU and starved every other user of the limiter.
// 20 views in 10 minutes is far above what a doctor opening a report needs (an empirical
// allowance, not a derived number), and keying by token means one link's abuse leaves the
// others alone.
const SHARED_REPORT_WINDOW_MS = 10 * 60 * 1000;
const SHARED_REPORT_MAX_VIEWS = 20;
const sharedReportHits = new Map(); // token -> { count, windowStart }

function sharedReportLimited(token) {
  const now = Date.now();
  for (const [key, rec] of sharedReportHits) {
    if (now - rec.windowStart > SHARED_REPORT_WINDOW_MS) sharedReportHits.delete(key);
  }
  let rec = sharedReportHits.get(token);
  if (!rec) {
    rec = { count: 0, windowStart: now };
    sharedReportHits.set(token, rec);
  }
  rec.count += 1;
  return rec.count > SHARED_REPORT_MAX_VIEWS;
}

router.get('/api/public/shared-reports/:token', async (req, res) => {
  // A health report must not be kept by shared caches or indexed if the link ever ends up on
  // a page a crawler sees. Set for every answer, including the 404, so a revoked link does not
  // linger in a cache either. Referrer-Policy keeps the token-bearing URL out of the Referer
  // of anything the PDF viewer might load.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (sharedReportLimited(req.params.token)) {
    res.setHeader('Retry-After', String(Math.ceil(SHARED_REPORT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Zbyt wiele żądań tego raportu. Spróbuj ponownie za kilka minut.' });
  }

  try {
    const share = await getActiveShareByToken(req.params.token);
    // Identical 404 for "does not exist", "revoked" and "expired" - see
    // komentarz w getActiveShareByToken.
    if (!share) {
      return res.status(404).json({ error: 'Link jest nieprawidłowy, wygasł albo został odwołany.' });
    }

    const pdfBuffer = await buildHealthReportPdf(share.userId, share.days, { endDate: share.endDate });
    res.setHeader('Content-Type', 'application/pdf');
    // inline (not attachment) - a link recipient usually just wants to view the report
    // in the browser rather than be forced to download a file.
    res.setHeader('Content-Disposition', 'inline; filename="dietetyk-ai-raport.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[SHARED REPORT ERROR]', err);
    res.status(500).json({ error: 'Błąd generowania raportu PDF.' });
  }
});

module.exports = router;

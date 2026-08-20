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
// This router MUST therefore be mounted in server.js BEFORE `app.use('/api', requireAuth)`,
// like routes/healthcheck.js and routes/appleHealth.js. The path starts with
// `/api/public/` (rather than `/api/user/...` like the rest of account.js) so that the URL
// alone makes it obvious this endpoint is public by design, not by an overlooked missing
// autoryzacji.
//
// The rate limiter (apiRateLimiter in server.js) is mounted on '/api' BEFORE this
// router, so it still covers this route - which matters, because the token is the only
// access barrier and the limiter makes guessing or brute-forcing it much harder.
router.get('/api/public/shared-reports/:token', async (req, res) => {
  try {
    const share = await getActiveShareByToken(req.params.token);
    // Identical 404 for "does not exist", "revoked" and "expired" - see
    // the comment in getActiveShareByToken.
    if (!share) {
      return res.status(404).json({ error: 'Link jest nieprawidłowy, wygasł albo został odwołany.' });
    }

    const pdfBuffer = await buildHealthReportPdf(share.userId, share.days);
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

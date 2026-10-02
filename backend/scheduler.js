const db = require('./db');
const { getLocalDateString, getWarsawWallClock } = require('./utils/dates');
const { syncAllOura, syncAllWithings, syncAllGoogleFit } = require('./services/sync');
const { sendWeeklySummaryForUser, sendDailySummaryForUser, sendMonthlySummaryForUser } = require('./services/summaries');
const { sendWeeklyAdminReport } = require('./services/adminReport');
const logger = require('./services/logger');

// Retry budget for a scheduled summary that failed to send.
//
// The "already sent" key (last_*_summary_sent) is written only after sendMailgunEmail
// succeeds, and each send generates the AI text afresh. So a summary that kept failing - Mailgun
// down, a recipient Mailgun rejects - was retried on EVERY 5-minute tick until the period
// ended: up to ~12 Gemini calls an hour per user until midnight (for the admin, on the
// application's own key), all of them thrown away. And a Mailgun call that delivered but
// answered after the 15 s timeout produced a duplicate email every five minutes.
//
// Now each attempt is claimed BEFORE the send, in settings under `summary_attempt_<kind>`
// ({ period, count, at }): at most SUMMARY_MAX_ATTEMPTS per period, at least
// SUMMARY_RETRY_BACKOFF_MS apart. A success clears the claim, so the next period starts
// fresh. The numbers are a judgement call: three tries an hour apart ride out a short Mailgun
// outage without turning a long one into dozens of Gemini calls.
const SUMMARY_MAX_ATTEMPTS = 3;
const SUMMARY_RETRY_BACKOFF_MS = 60 * 60 * 1000;

async function claimSummaryAttempt(userId, kind, periodKey) {
  const key = `summary_attempt_${kind}`;
  const row = await db.get(`SELECT value FROM settings WHERE user_id = ? AND key = ?`, [userId, key]);
  let previous = null;
  try {
    previous = row ? JSON.parse(row.value) : null;
  } catch {
    previous = null;
  }
  const now = Date.now();
  const samePeriod = !!(previous && previous.period === periodKey);
  if (samePeriod && (previous.count >= SUMMARY_MAX_ATTEMPTS || now - previous.at < SUMMARY_RETRY_BACKOFF_MS)) {
    return false;
  }
  const next = { period: periodKey, count: samePeriod ? previous.count + 1 : 1, at: now };
  await db.run(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `, [userId, key, JSON.stringify(next)]);
  return true;
}

async function clearSummaryAttempt(userId, kind) {
  await db.run(`DELETE FROM settings WHERE user_id = ? AND key = ?`, [userId, `summary_attempt_${kind}`]);
}

async function checkAndSendAutomatedSummaries() {
  try {
    const users = await db.all(`SELECT id, username, email FROM users WHERE status = 'active'`);
    const todayStr = getLocalDateString();
    
    const now = new Date();
    // Schedules (scheduled_day/scheduled_time) are set by the user in Polish time - we
    // derive the day/hour/minute from the "Warsaw wall clock" rather than from the
    // Node process timezone (see the getWarsawWallClock comment in utils/dates.js).
    const warsawNow = getWarsawWallClock(now);
    // getUTCDay(): 0 (Sunday) to 6 (Saturday). We map 0 to 7 and leave the rest as is.
    const currentDay = warsawNow.getUTCDay() === 0 ? 7 : warsawNow.getUTCDay();
    const currentHour = warsawNow.getUTCHours();
    const currentMinute = warsawNow.getUTCMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    console.log(`[SCHEDULER] Checking summary schedules. Weekday: ${currentDay}, time: ${currentTimeStr}, date: ${todayStr}`);

    for (const user of users) {
      const settingsRows = await db.all(`SELECT key, value FROM settings WHERE user_id = ?`, [user.id]);
      const settings = {};
      settingsRows.forEach(r => {
        settings[r.key] = r.value;
      });

      const enabled = settings.weekly_summary_enabled === '1'; // master switch for summaries
      const scheduledDay = Number(settings.weekly_summary_day || 1); // defaults to Monday (1)
      const scheduledTime = settings.weekly_summary_time || '18:00';
      
      const lastWeeklySent = settings.last_weekly_summary_sent || '';
      const lastDailySent = settings.last_daily_summary_sent || '';

      // --- Monthly summary (its own enable flag, independent of weekly/daily) ---
      const monthlyEnabled = settings.monthly_summary_enabled === '1';
      const monthlyScheduledDayRaw = Number(settings.monthly_summary_day || 1); // defaults to the 1st of the month
      const monthlyScheduledTime = settings.monthly_summary_time || '09:00';
      const lastMonthlySent = settings.last_monthly_summary_sent || ''; // idempotency key: 'YYYY-MM', not a full date
      const currentYearMonthStr = todayStr.slice(0, 7); // 'YYYY-MM'

      if (monthlyEnabled) {
        // Clamp to the last day of the month when the configured day (31, say) does not
        // exist in that month (February, April and so on) - the summary then goes out on
        // that month's final day.
        const daysInCurrentMonth = new Date(Date.UTC(warsawNow.getUTCFullYear(), warsawNow.getUTCMonth() + 1, 0)).getUTCDate();
        const effectiveMonthlyDay = Math.min(monthlyScheduledDayRaw, daysInCurrentMonth);

        if (warsawNow.getUTCDate() === effectiveMonthlyDay) {
          if (currentTimeStr >= monthlyScheduledTime) {
            if (lastMonthlySent !== currentYearMonthStr) {
              console.log(`[SCHEDULER] Sending the monthly summary to ${user.username} (${user.email || 'no email'})`);
              if (user.email && !(await claimSummaryAttempt(user.id, 'monthly', currentYearMonthStr))) {
                console.warn(`[SCHEDULER] Skipping the monthly summary for ${user.username} - retry budget for this period used up or backing off after a failure.`);
              } else if (user.email) {
                try {
                  await sendMonthlySummaryForUser(user.id);
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_monthly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, currentYearMonthStr]);
                  console.log(`[SCHEDULER] Sent the monthly summary to ${user.username}; last_monthly_summary_sent set to ${currentYearMonthStr}`);
                  await clearSummaryAttempt(user.id, 'monthly');
                } catch (sendErr) {
                  console.error(`[SCHEDULER ERROR] Failed to send the monthly summary to ${user.username}:`, sendErr.message);
                }
              } else {
                console.warn(`[SCHEDULER WARNING] Cannot send the monthly summary to ${user.username} - no email address set.`);
              }
            }
          }
        }
      }

      if (enabled) {
        // --- 1. Podsumowanie Codzienne ---
        if (currentTimeStr >= scheduledTime) {
          if (lastDailySent !== todayStr) {
            console.log(`[SCHEDULER] Sending the daily summary to ${user.username} (${user.email || 'no email'})`);
            if (user.email && !(await claimSummaryAttempt(user.id, 'daily', todayStr))) {
              console.warn(`[SCHEDULER] Skipping the daily summary for ${user.username} - retry budget for this period used up or backing off after a failure.`);
            } else if (user.email) {
              try {
                await sendDailySummaryForUser(user.id);
                await db.run(`
                  INSERT INTO settings (user_id, key, value)
                  VALUES (?, 'last_daily_summary_sent', ?)
                  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                `, [user.id, todayStr]);
                console.log(`[SCHEDULER] Sent the daily summary to ${user.username}; last_daily_summary_sent set to ${todayStr}`);
                await clearSummaryAttempt(user.id, 'daily');
              } catch (sendErr) {
                console.error(`[SCHEDULER ERROR] Failed to send the daily summary to ${user.username}:`, sendErr.message);
              }
            } else {
              console.warn(`[SCHEDULER WARNING] Cannot send the daily summary to ${user.username} - no email address set.`);
            }
          }
        }

        // --- 2. Podsumowanie Tygodniowe ---
        if (currentDay === scheduledDay) {
          if (currentTimeStr >= scheduledTime) {
            if (lastWeeklySent !== todayStr) {
              console.log(`[SCHEDULER] Sending the weekly summary to ${user.username} (${user.email || 'no email'})`);
              if (user.email && !(await claimSummaryAttempt(user.id, 'weekly', todayStr))) {
                console.warn(`[SCHEDULER] Skipping the weekly summary for ${user.username} - retry budget for this period used up or backing off after a failure.`);
              } else if (user.email) {
                try {
                  await sendWeeklySummaryForUser(user.id);
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_weekly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, todayStr]);
                  console.log(`[SCHEDULER] Sent the weekly summary to ${user.username}; last_weekly_summary_sent set to ${todayStr}`);
                  await clearSummaryAttempt(user.id, 'weekly');
                } catch (sendErr) {
                  console.error(`[SCHEDULER ERROR] Failed to send the weekly summary to ${user.username}:`, sendErr.message);
                }
              } else {
                console.warn(`[SCHEDULER WARNING] Cannot send the weekly summary to ${user.username} - no email address set.`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] checkAndSendAutomatedSummaries failed:', err);
  }
}

// --- HOURLY SYNC SCHEDULE (05:00-22:00, then an overnight pause) ---
const SYNC_WINDOW_START_HOUR = 5;  // 5:00 rano
const SYNC_WINDOW_END_HOUR = 22;   // through 22:00 inclusive

function isWithinSyncWindow(date = new Date()) {
  // The 05:00-22:00 window is meaningful in the Polish time its users live in - we read
  // the hour from the Warsaw wall clock, not the process timezone (see getWarsawWallClock).
  const hour = getWarsawWallClock(date).getUTCHours();
  return hour >= SYNC_WINDOW_START_HOUR && hour <= SYNC_WINDOW_END_HOUR;
}

// We remember the last hour (0-23) for which a sync ran, so that it fires at most once
// per clock hour.
let lastSyncedHourKey = null;

// NOTE: setting `lastSyncedHourKey` BEFORE the sync runs only protects
// against running again WITHIN THE SAME hour (the next 5-minute tick carries the same
// hourKey). It does NOT protect against overlapping runs when syncing many users -
// processed SEQUENTIALLY, see syncAllOura/syncAllWithings/syncAllGoogleFit in sync.js -
// takes longer than the remainder of the clock hour. Then hourKey changes, the previous
// condition lets a new call through, and two full runs proceed concurrently, hitting the
// same external APIs and database rows for the same users. The `isSyncRunning` flag is a
// second, independent guard against exactly that overlap. (Summary emails used to be
// covered by these two guards as well; they have their own guard now - see
// isSummaryCheckRunning below.)
let isSyncRunning = false;
let syncStartedAtMs = null;

// How long a healthy external sync may hold `isSyncRunning` before we treat the flag as
// stuck and release it. A run is a handful of sequential HTTP calls per user, each bounded
// by fetchWithTimeout (15s by default, and that timeout now covers reading the response
// BODY as well - see utils/fetchWithTimeout.js, which is what used to let a run hang
// forever). 30 minutes is far outside anything healthy and inside the one-hour cadence.
//
// Releasing the flag can in principle let a second run start while a first is somehow still
// alive. That was unacceptable while the summary sends lived behind this flag - two runs
// meant two emails - but they no longer do (see below), and the remaining work is upserts
// into health_metrics, which are idempotent. A standstill until the next pod restart is the
// worse of the two failures.
const SYNC_STUCK_AFTER_MS = 30 * 60 * 1000;

// Summaries get their own re-entrancy guard now that they run on every 5-minute tick rather
// than once an hour. `last_*_summary_sent` is written AFTER the mail goes out, so two
// overlapping checks - a send slower than the tick interval - would each see "not sent yet"
// and each send.
let isSummaryCheckRunning = false;

async function runHourlySyncIfDue() {
  const now = new Date();
  // Round 15 audit fix: now.getHours() reads the hour from the process timezone rather
  // than Warsaw time - inconsistent with isWithinSyncWindow() above, which deliberately
  // uses getWarsawWallClock(). On UTC hosting, hourKey could drift away from the actual
  // hour in Warsaw.
  const warsawHour = getWarsawWallClock(now).getUTCHours();
  const hourKey = `${getLocalDateString()}T${warsawHour}`;

  // THE ONCE-PER-HOUR GATE PROTECTS THE EXTERNAL SYNCS, NOTHING ELSE (audit 2026-09-23).
  //
  // The 05:00-22:00 window and the hourKey gate exist for Oura/Withings/Google Fit: there is
  // nothing to fetch overnight, and no reason to burn those API quotas every five minutes.
  // The summary check used to sit behind both of them, and behind the hourKey gate in
  // particular that is fatal, because checkAndSendAutomatedSummaries() decides on
  // `currentTimeStr >= scheduledTime`. The gate lets through only the FIRST tick of each
  // clock hour, so the user's configured time was compared exactly once an hour, at whatever
  // minute the process happened to start on. A summary set for 23:30 on a pod whose ticks
  // land on :00/:05/:10 was tested at 23:00 ('23:00' >= '23:30' is false) and never again:
  // the 23:35 and 23:55 ticks were dropped by the gate, and after midnight todayStr changes
  // while every later comparison that day ('00:05' >= '23:30', '05:05' >= '23:30', ...) is
  // false as well. The mail simply never went, and the log showed a perfectly ordinary
  // "Checking summary schedules" line. An earlier fix removed the window from this path;
  // the gate was left in place and kept the same hole open for a narrower set of minutes.
  //
  // So: the gate and the window now wrap ONLY syncAll*. The summary check and the admin
  // report run on every tick - they are idempotent through the `last_*_summary_sent` /
  // `last_admin_report_sent` keys, which is what makes running them 12x more often free.
  if (hourKey !== lastSyncedHourKey && isWithinSyncWindow(now)) {
    if (isSyncRunning && syncStartedAtMs !== null && (Date.now() - syncStartedAtMs) > SYNC_STUCK_AFTER_MS) {
      console.error(
        `[SCHEDULER ERROR] The external sync has been marked as running for ${Math.round((Date.now() - syncStartedAtMs) / 60000)} minutes ` +
        '- far beyond any healthy run. Releasing the guard so syncing can resume; see SYNC_STUCK_AFTER_MS.'
      );
      isSyncRunning = false;
      syncStartedAtMs = null;
    }

    if (isSyncRunning) {
      console.warn('[SCHEDULER] The previous sync run is still in progress - skipping this tick to avoid overlapping runs.');
    } else {
      lastSyncedHourKey = hourKey;
      isSyncRunning = true;
      syncStartedAtMs = Date.now();
      try {
        console.log(`[SCHEDULER] Starting the hourly data sync (hour ${warsawHour}:00)...`);
        await syncAllOura();
        await syncAllWithings();
        await syncAllGoogleFit();
      } catch (err) {
        console.error('[SCHEDULER ERROR] Hourly sync failed:', err);
      } finally {
        isSyncRunning = false;
        syncStartedAtMs = null;
      }
    }
  }

  // Summaries run on EVERY tick, and deliberately outside the try/finally above: a failing
  // or stuck external sync must not be able to take the mail with it.
  if (isSummaryCheckRunning) {
    console.warn('[SCHEDULER] The previous summary check is still running - skipping this tick.');
    return;
  }
  isSummaryCheckRunning = true;
  try {
    await checkAndSendAutomatedSummaries();
    await runWeeklyAdminReportIfDue();
  } catch (err) {
    console.error('[SCHEDULER ERROR] The summary check failed:', err);
  } finally {
    isSummaryCheckRunning = false;
  }
}

// Takes a database backup and runs the irreversible cleanups ONLY when that backup exists
// and verified. Called from server.js at startup and once every 24 hours.
//
// The order used to be the other way round - cleanupOldImages() (blanks meal photos older
// than 14 days, then VACUUMs) and cleanupOldLogs() (deletes app_logs rows) ran first, and
// backupDatabase() reported failure by printing `[BACKUP ERROR]` and returning, with nobody
// looking. A `./data` volume filling up is enough to make `VACUUM INTO` fail every night
// while the cleanup keeps deleting: after a fortnight the freshest usable backup predates
// the failure, and the photos deleted in between exist nowhere. A missing backup has to STOP
// the deletion, not annotate it.
//
// A failed backup is escalated through logger.error, which writes to app_logs and therefore
// reaches the weekly administrator report - unlike console.error, which reaches the container
// log and stops there. Returns { ok, cleaned } so a test can see which branch was taken.
async function runBackupThenCleanup(trigger) {
  console.log(`[CRON] Database backup (${trigger})...`);
  const backup = await db.backupDatabase();

  if (!backup || !backup.ok) {
    const reason = backup && backup.reason ? backup.reason : 'unknown reason';
    logger.error(
      `Database backup failed (${reason}) - SKIPPING the cleanup of old photos and logs. Nothing has been deleted; the data stays unprotected until a backup succeeds.`,
      'SYSTEM'
    );
    return { ok: false, cleaned: false };
  }

  console.log('[CRON] Running the periodic cleanup of old photos and logs...');
  await db.cleanupOldImages();
  await db.cleanupOldLogs();
  await db.cleanupOldAppleHealthHours();
  return { ok: true, cleaned: true };
}

async function runWeeklyAdminReportIfDue() {
  try {
    const todayStr = getLocalDateString(); // 'YYYY-MM-DD'
    const now = new Date();
    // The report should go out on Monday at 08:00 Polish time - read from the
    // Warsaw clock, not the process timezone (see getWarsawWallClock in utils/dates.js).
    const warsawNow = getWarsawWallClock(now);

    // getUTCDay() = 1 (Monday)
    const currentDay = warsawNow.getUTCDay() === 0 ? 7 : warsawNow.getUTCDay();
    const currentHour = warsawNow.getUTCHours();
    const currentMinute = warsawNow.getUTCMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
    
    // Send every Monday (1) from 08:00 onwards
    if (currentDay === 1 && currentTimeStr >= '08:00') {
      const lastSentRow = await db.get(`SELECT value FROM app_config WHERE key = 'last_admin_report_sent'`);
      const lastSentDate = lastSentRow ? lastSentRow.value : '';

      // Send only once on a given Monday
      if (lastSentDate !== todayStr) {
        console.log(`[SCHEDULER] Sending the weekly log and security report to administrators...`);
        await sendWeeklyAdminReport();
        
        await db.run(`
          INSERT INTO app_config (key, value)
          VALUES ('last_admin_report_sent', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `, [todayStr]);
        console.log(`[SCHEDULER] Admin report sent; last_admin_report_sent set to ${todayStr}`);
      }
    }
  } catch (err) {
    console.error('[SCHEDULER ERROR] Failed while checking or sending the admin report:', err.message);
  }
}

module.exports = {
  checkAndSendAutomatedSummaries,
  isWithinSyncWindow,
  runHourlySyncIfDue,
  runBackupThenCleanup,
  runWeeklyAdminReportIfDue
};

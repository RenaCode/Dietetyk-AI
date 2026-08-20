const db = require('./db');
const { getLocalDateString, getWarsawWallClock } = require('./utils/dates');
const { syncAllOura, syncAllWithings, syncAllGoogleFit } = require('./services/sync');
const { sendWeeklySummaryForUser, sendDailySummaryForUser, sendMonthlySummaryForUser } = require('./services/summaries');
const { sendWeeklyAdminReport } = require('./services/adminReport');

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
              if (user.email) {
                try {
                  await sendMonthlySummaryForUser(user.id);
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_monthly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, currentYearMonthStr]);
                  console.log(`[SCHEDULER] Sent the monthly summary to ${user.username}; last_monthly_summary_sent set to ${currentYearMonthStr}`);
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
            if (user.email) {
              try {
                await sendDailySummaryForUser(user.id);
                await db.run(`
                  INSERT INTO settings (user_id, key, value)
                  VALUES (?, 'last_daily_summary_sent', ?)
                  ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                `, [user.id, todayStr]);
                console.log(`[SCHEDULER] Sent the daily summary to ${user.username}; last_daily_summary_sent set to ${todayStr}`);
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
              if (user.email) {
                try {
                  await sendWeeklySummaryForUser(user.id);
                  await db.run(`
                    INSERT INTO settings (user_id, key, value)
                    VALUES (?, 'last_weekly_summary_sent', ?)
                    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
                  `, [user.id, todayStr]);
                  console.log(`[SCHEDULER] Sent the weekly summary to ${user.username}; last_weekly_summary_sent set to ${todayStr}`);
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
// condition lets a new call through, and two full runs proceed concurrently: hitting the
// same external APIs and database rows for the same users, and potentially sending
// summary emails TWICE. The `isSyncRunning` flag is a second, independent guard against
// exactly that overlap.
let isSyncRunning = false;

async function runHourlySyncIfDue() {
  const now = new Date();
  // Round 15 audit fix: now.getHours() reads the hour from the process timezone rather
  // than Warsaw time - inconsistent with isWithinSyncWindow() above, which deliberately
  // uses getWarsawWallClock(). On UTC hosting, hourKey could drift away from the actual
  // hour in Warsaw.
  const warsawHour = getWarsawWallClock(now).getUTCHours();
  const hourKey = `${getLocalDateString()}T${warsawHour}`;

  if (!isWithinSyncWindow(now)) {
    return; // Przerwa nocna (22:00 - 5:00) - brak synchronizacji
  }

  if (hourKey === lastSyncedHourKey) {
    return; // this hour's sync has already run
  }

  if (isSyncRunning) {
    console.warn('[SCHEDULER] The previous sync run is still in progress - skipping this tick to avoid overlapping runs.');
    return;
  }

  lastSyncedHourKey = hourKey;
  isSyncRunning = true;
  console.log(`[SCHEDULER] Uruchamianie godzinowej synchronizacji danych (godzina ${warsawHour}:00)...`);
  try {
    await syncAllOura();
    await syncAllWithings();
    await syncAllGoogleFit();
    await checkAndSendAutomatedSummaries();
    await runWeeklyAdminReportIfDue();
    console.log('[SCHEDULER] Hourly sync and summaries finished.');
  } catch (err) {
    console.error('[SCHEDULER ERROR] Hourly sync failed:', err);
  } finally {
    isSyncRunning = false;
  }
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
  runWeeklyAdminReportIfDue
};

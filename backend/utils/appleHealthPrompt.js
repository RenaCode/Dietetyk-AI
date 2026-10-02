// The Apple Health block for AI prompts (chat, Dashboard advice, daily summary): the day's
// extra metrics plus symptoms / heart-rate notifications / cycle position.
//
// One function for all three callers so they cannot drift apart, and it NEVER throws: the
// chat, the advice and the summary email worked long before this data existed, and a
// failure reading it (a locked or full database, a malformed row) must cost only this
// optional context, not the whole answer (audit 2026-10-02 - before this, any error here
// turned every chat message into a 500 and stopped the daily email).

const { getDailyMetrics, getDailyMetricsRange, formatDailyMetricsForPrompt, isDietary } = require('./appleHealthSamples');
const {
  getDailyEvents,
  formatDailyEventsForPrompt,
  getCycleDay,
  describeCycle
} = require('./appleHealthEvents');
const { shiftDate } = require('./dates');
const { columnBackedMetrics } = require('./appleHealthColumns');

/**
 * @returns {Promise<string|null>} newline-joined prompt lines, or null when there is nothing
 *   to add or reading failed.
 */
async function buildAppleHealthPromptContext(db, userId, date, language = 'pl') {
  try {
    const metrics = await getDailyMetrics(db, userId, date, {
      exclude: await columnBackedMetrics(db, userId)
    });
    const events = await getDailyEvents(db, userId, date);
    const lines = [
      formatDailyMetricsForPrompt(metrics, language),
      formatDailyEventsForPrompt(events, language)
    ].filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (err) {
    console.error(`[APPLE HEALTH] Failed to build prompt context for user ${userId}, date ${date}:`, err.message);
    return null;
  }
}

// Same bound as the daily line: every genuine metric fits, an invented flood does not.
const MAX_PERIOD_METRICS = 40;
// A trend needs two full weeks to compare; shorter periods get averages only.
const MIN_DAYS_FOR_TREND = 14;
// Below this a week-on-week change is noise for every metric we carry (empirical, not clinical).
const TREND_THRESHOLD_PCT = 5;

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * The Apple Health block for analyses that look at a PERIOD rather than one day: the
 * training-plan review, weekly/monthly summaries, long-range chat questions, and the 7-day
 * trend in the Dashboard advice. Per metric: the mean daily value over the period and, for
 * periods of two weeks or more, the last 7 days against the 7 before. Plus the period's
 * symptoms and heart-rate notifications counted by name, and the cycle position at the end.
 *
 * Never throws - see the header of this file.
 * @returns {Promise<string|null>}
 */
async function buildAppleHealthPeriodContext(db, userId, startDate, endDate, language = 'pl') {
  const en = language === 'en';
  try {
    const byMetric = await getDailyMetricsRange(db, userId, startDate, endDate, {
      exclude: await columnBackedMetrics(db, userId)
    });
    const periodDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
    const lastWeekStart = shiftDate(endDate, -6);
    const prevWeekStart = shiftDate(endDate, -13);

    const parts = [];
    for (const [metric, days] of byMetric) {
      // Same rule as the daily line: intake logged by other apps would contradict this
      // app's own meal totals.
      if (isDietary(metric) && metric !== 'dietary_caffeine') continue;
      const avg = round1(mean(days.map((d) => d.value)));
      const units = days[days.length - 1].units;
      const name = en ? metric : `${days[0].label} (${metric})`;
      let text = `${name}: ${en ? 'avg' : 'śr.'} ${avg}${units ? ' ' + units : ''}/${en ? 'day' : 'dzień'} (${days.length} ${en ? 'd' : 'dni'})`;
      if (periodDays >= MIN_DAYS_FOR_TREND) {
        const last = days.filter((d) => d.date >= lastWeekStart).map((d) => d.value);
        const prev = days.filter((d) => d.date >= prevWeekStart && d.date < lastWeekStart).map((d) => d.value);
        if (last.length >= 3 && prev.length >= 3) {
          const prevMean = mean(prev);
          if (prevMean !== 0) {
            const pct = Math.round(((mean(last) - prevMean) / Math.abs(prevMean)) * 100);
            if (Math.abs(pct) >= TREND_THRESHOLD_PCT) {
              text += en ? `, last 7 d vs previous 7 d: ${pct > 0 ? '+' : ''}${pct}%` : `, ost. 7 dni vs poprzednie 7: ${pct > 0 ? '+' : ''}${pct}%`;
            }
          }
        }
      }
      parts.push(text);
      if (parts.length >= MAX_PERIOD_METRICS) break;
    }

    const lines = [];
    if (parts.length > 0) {
      lines.push(en
        ? `- Apple Health / Apple Watch, ${startDate}..${endDate}: ${parts.join('; ')}`
        : `- Apple Health / Apple Watch, ${startDate}..${endDate}: ${parts.join('; ')}`);
    }

    const events = await db.all(
      `SELECT kind, name, value, date FROM apple_health_events
       WHERE user_id = ? AND date >= ? AND date <= ? AND kind IN ('symptom', 'heart_rate_notification')
       ORDER BY date`,
      [userId, startDate, endDate]
    );
    const absence = new Set(['Not Present', 'None']);
    const counts = (kind) => {
      const map = new Map();
      for (const e of events) {
        if (e.kind !== kind || absence.has(e.value)) continue;
        map.set(e.name, (map.get(e.name) || 0) + 1);
      }
      return [...map].map(([n, c]) => `${n} x${c}`).join(', ');
    };
    const symptoms = counts('symptom');
    const notifications = counts('heart_rate_notification');
    if (symptoms) lines.push(en ? `- Symptoms logged in the period: ${symptoms}` : `- Objawy zapisane w okresie: ${symptoms}`);
    if (notifications) {
      lines.push(en
        ? `- Apple Watch heart-rate notifications in the period: ${notifications} (screening signal, not a diagnosis)`
        : `- Powiadomienia o tętnie z Apple Watch w okresie: ${notifications} (sygnał przesiewowy, nie diagnoza)`);
    }

    // Adherence per medication/supplement over the period, from Health's dose log. Only
    // doses the user actually answered (Taken/Skipped) count: "Not Logged" says nothing about
    // whether the pill was taken, and counting it as missed would invent non-adherence.
    const doses = await db.all(
      `SELECT name, value FROM apple_health_events
       WHERE user_id = ? AND kind = 'medication' AND date >= ? AND date <= ? AND value IN ('Taken', 'Skipped')`,
      [userId, startDate, endDate]
    );
    if (doses.length > 0) {
      const perMed = new Map();
      for (const d of doses) {
        const m = perMed.get(d.name) || { taken: 0, total: 0 };
        m.total += 1;
        if (d.value === 'Taken') m.taken += 1;
        perMed.set(d.name, m);
      }
      const text = [...perMed].map(([n, m]) => `${n} ${m.taken}/${m.total}`).join(', ');
      lines.push(en
        ? `- Medications/supplements from Apple Health, doses taken/logged in the period: ${text}`
        : `- Leki/suplementy z Apple Health, dawki przyjęte/zalogowane w okresie: ${text}`);
    }

    const cycle = describeCycle(await getCycleDay(db, userId, endDate), language);
    if (cycle) {
      lines.push(en
        ? `- Menstrual cycle on ${endDate}: day ${cycle.day}, ${cycle.phaseLabel}${cycle.estimated ? ' (estimated from a default 28-day cycle)' : ''}. ${cycle.note}`
        : `- Cykl miesiączkowy na ${endDate}: dzień ${cycle.day}, ${cycle.phaseLabel}${cycle.estimated ? ' (szacunek z domyślnego cyklu 28 dni)' : ''}. ${cycle.note}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch (err) {
    console.error(`[APPLE HEALTH] Failed to build period prompt context for user ${userId}, ${startDate}..${endDate}:`, err.message);
    return null;
  }
}

module.exports = { buildAppleHealthPromptContext, buildAppleHealthPeriodContext };

// The Apple Health block for AI prompts (chat, Dashboard advice, daily summary): the day's
// extra metrics plus symptoms / heart-rate notifications / cycle position.
//
// One function for all three callers so they cannot drift apart, and it NEVER throws: the
// chat, the advice and the summary email worked long before this data existed, and a
// failure reading it (a locked or full database, a malformed row) must cost only this
// optional context, not the whole answer (audit 2026-10-02 - before this, any error here
// turned every chat message into a 500 and stopped the daily email).

const { getDailyMetrics, formatDailyMetricsForPrompt } = require('./appleHealthSamples');
const { getDailyEvents, formatDailyEventsForPrompt } = require('./appleHealthEvents');
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

module.exports = { buildAppleHealthPromptContext };

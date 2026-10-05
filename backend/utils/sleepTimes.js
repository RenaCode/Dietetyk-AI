// Bedtime and wake time of the night stored on a health_metrics row (sleep_start, sleep_end).
//
// Until this module existed the Apple Health webhook parsed the start and end of every sleep
// fragment, used them only to compute a duration, and threw them away; Oura's bedtime_start /
// bedtime_end were never read at all. Duration alone cannot answer "is this person's sleep
// regular" - 7 h from 23:00 and 7 h from 03:00 look identical - so the times are now kept.
//
// WHAT IS STORED
// - sleep_start / sleep_end: ISO 8601 with the Europe/Warsaw offset of that instant (see
//   toWarsawIsoString in utils/dates.js), i.e. an absolute moment. Compare with julianday()
//   in SQL or Date.parse() in JS, never as strings.
// - sleep_times_source: who wrote the PAIR ('oura' | 'apple'). One provenance column for both
//   values on purpose: a bedtime from one source and a wake time from another is a night that
//   never happened, so the two are always written together or not at all.
// - The row's `date` is the day the user WOKE UP, in Europe/Warsaw - the same convention the
//   webhook already uses for sleep_duration (end date of the entry) and that Oura uses for
//   its `day` field. routes/dashboard.js (dayBeforeNight / dayAfterNight) relies on it.
//
// MAIN SLEEP BLOCK - the rule for a night recorded as several fragments
// Apple Health sends a night as many stage segments (Core 23:40-00:10, Deep 00:10-00:35,
// Awake 03:02-03:10, ...) and Oura can split one night into two `long_sleep` records when the
// wearer was up in the middle. Fragments separated by less than SLEEP_BLOCK_GAP_HOURS belong
// to the same block. Bedtime is the EARLIEST start in the block and wake time the LATEST end.
// When a day has several blocks (a night plus an afternoon nap), the main block is the one
// with the most time asleep; a tie goes to the longer span. Naps therefore never move the
// wake time to 16:00, and a short wake-up at 3 a.m. does not cut the night in two.
//
// SOURCE PRIORITY: oura > apple, the same order sleep_duration follows (Apple Health does not
// overwrite Oura's sleep; Oura replaces Apple's night when it has a main sleep of its own).
// It is expressed through sleep_times_source rather than the readiness_score proxy the
// sleep_duration guard uses, following the per-column provenance convention of
// utils/activitySources.js: Oura blocks Apple only from a pair Oura actually wrote. A day the
// ring recorded only naps (no long_sleep, so no Oura times) can still get Apple's night.

// EMPIRICAL, not clinical: a gap of up to an hour between two sleep fragments is treated as
// waking up during the night, a longer one as two separate sleeps. It is a judgement call,
// NOT tuned on recorded nights: a much shorter threshold risks cutting a night in two at an
// ordinary awakening, a much longer one starts gluing a mid-morning nap onto the night and
// pushes the wake time hours later. Revisit it once there is real data to look at.
const SLEEP_BLOCK_GAP_HOURS = 1;
const HOUR_MS = 60 * 60 * 1000;

const SLEEP_TIME_SOURCE_RANK = {
  oura: 2,
  apple: 1
};

/**
 * Groups sleep fragments into blocks (see MAIN SLEEP BLOCK above).
 *
 * @param {Array<{start: Date, end: Date, asleepHours: number}>} fragments
 * @returns {Array<{start: Date, end: Date, asleepHours: number}>} blocks in time order
 */
function groupSleepBlocks(fragments) {
  const valid = fragments
    .filter(f => f && f.start instanceof Date && f.end instanceof Date && f.end > f.start)
    .sort((a, b) => a.start - b.start);
  const blocks = [];
  for (const f of valid) {
    const last = blocks[blocks.length - 1];
    if (last && f.start - last.end < SLEEP_BLOCK_GAP_HOURS * HOUR_MS) {
      if (f.end > last.end) last.end = f.end;
      last.asleepHours += f.asleepHours || 0;
    } else {
      blocks.push({ start: f.start, end: f.end, asleepHours: f.asleepHours || 0 });
    }
  }
  return blocks;
}

function pickMainBlock(blocks) {
  let main = null;
  for (const b of blocks) {
    if (!main
      || b.asleepHours > main.asleepHours
      || (b.asleepHours === main.asleepHours && (b.end - b.start) > (main.end - main.start))) {
      main = b;
    }
  }
  return main;
}

/**
 * The main sleep block of every wake-up day the fragments cover.
 *
 * Blocks are built BEFORE they are assigned to a day, and the day is taken from the block's
 * end. Bucketing the raw fragments by their own end date first - which is what the webhook
 * does for sleep_duration - would split a night at midnight: a Core segment ending at 23:50
 * would land on the previous day as a "night" of its own.
 *
 * @param {Array<{start: Date, end: Date, asleepHours: number}>} fragments
 * @param {(date: Date) => string} dayOf maps an instant to its YYYY-MM-DD wake-up day
 * @returns {Object<string, {start: Date, end: Date, asleepHours: number}>}
 */
function mainSleepBlocksByDay(fragments, dayOf) {
  const byDay = {};
  for (const block of groupSleepBlocks(fragments)) {
    const day = dayOf(block.end);
    (byDay[day] = byDay[day] || []).push(block);
  }
  const result = {};
  for (const [day, blocks] of Object.entries(byDay)) {
    result[day] = pickMainBlock(blocks);
  }
  return result;
}

/**
 * Bedtime and wake time from the records Oura's /v2/usercollection/sleep returned for one
 * `day`. Only `long_sleep` records count: Oura's `sleep` / `late_nap` / `rest` types are naps
 * and rest periods, and the sleep_duration logic in services/sync.js already refuses to let
 * those stand in for a night.
 *
 * Bedtime is bedtime_start + latency (seconds to fall asleep, when Oura reports it), so that it
 * means "fell asleep" - the same thing Apple's sleepStart means. Without the latency an Oura
 * night would start earlier, by the time spent falling asleep, than the same night measured by
 * an Apple Watch, and a user switching devices would see a shift in regularity that is only a
 * difference in definitions.
 *
 * @returns {{start: Date, end: Date}|null}
 */
function ouraMainSleepTimes(items) {
  const fragments = [];
  for (const item of items || []) {
    if (!item || item.type !== 'long_sleep') continue;
    const bedStart = item.bedtime_start ? new Date(item.bedtime_start) : null;
    const end = item.bedtime_end ? new Date(item.bedtime_end) : null;
    if (!bedStart || !end || isNaN(bedStart.getTime()) || isNaN(end.getTime())) continue;
    const latencySec = Number.isFinite(item.latency) && item.latency > 0 ? item.latency : 0;
    const start = new Date(bedStart.getTime() + latencySec * 1000);
    fragments.push({ start: start < end ? start : bedStart, end, asleepHours: (item.total_sleep_duration || 0) / 3600 });
  }
  return pickMainBlock(groupSleepBlocks(fragments));
}

const rankSql = (sourceColumn) => `CASE ${sourceColumn} ${Object.entries(SLEEP_TIME_SOURCE_RANK)
  .map(([name, rank]) => `WHEN '${name}' THEN ${rank}`)
  .join(' ')} ELSE 0 END`;

/**
 * The three ON CONFLICT assignments (sleep_start, sleep_end, sleep_times_source) for a write
 * from `source`.
 *
 * - An incoming NULL pair never erases a stored one (a payload without sleep, an Oura day
 *   with naps only).
 * - A stored pair written by a HIGHER-ranked source is kept.
 * - Oura, the top source, replaces whatever is stored: its record is the night as the ring
 *   finalised it, not a partial view.
 * - Apple MERGES with its own earlier pair. Health Auto Export re-sends the night in pieces
 *   (an export at 03:00 carries 23:10-03:00, the one at 08:00 the whole night), so when the
 *   two intervals overlap or lie within SLEEP_BLOCK_GAP_HOURS of each other they are the same
 *   block and the union is kept. When they are separate sleeps - an afternoon nap exported on
 *   its own after the morning's night - the longer span stays, so the nap cannot replace the
 *   night it came after.
 *
 * Every comparison goes through julianday(), which understands the "+02:00" suffix; comparing
 * the strings would order 02:15+01:00 before 02:30+02:00 on the night clocks go back.
 * All right-hand sides read the row as it was before the UPDATE (SQLite semantics), so the
 * three assignments see the same old pair and cannot disagree with each other.
 */
function sleepTimesUpdateSql(source) {
  const incomingRank = SLEEP_TIME_SOURCE_RANK[source] || 0;
  const keepStored = `excluded.sleep_start IS NULL OR excluded.sleep_end IS NULL
                OR (sleep_start IS NOT NULL AND (${rankSql('sleep_times_source')}) > ${incomingRank})`;
  const takeIncoming = `sleep_start IS NULL OR sleep_end IS NULL
                OR (${rankSql('sleep_times_source')}) < ${incomingRank}`;
  const gapDays = SLEEP_BLOCK_GAP_HOURS / 24;
  const sameBlock = `julianday(excluded.sleep_start) <= julianday(sleep_end) + ${gapDays}
                AND julianday(excluded.sleep_end) >= julianday(sleep_start) - ${gapDays}`;
  const incomingLonger = `julianday(excluded.sleep_end) - julianday(excluded.sleep_start)
                > julianday(sleep_end) - julianday(sleep_start)`;
  return `sleep_start = CASE
              WHEN ${keepStored} THEN sleep_start
              WHEN ${takeIncoming} THEN excluded.sleep_start
              WHEN ${sameBlock} THEN
                CASE WHEN julianday(excluded.sleep_start) < julianday(sleep_start) THEN excluded.sleep_start ELSE sleep_start END
              WHEN ${incomingLonger} THEN excluded.sleep_start
              ELSE sleep_start
            END,
            sleep_end = CASE
              WHEN ${keepStored} THEN sleep_end
              WHEN ${takeIncoming} THEN excluded.sleep_end
              WHEN ${sameBlock} THEN
                CASE WHEN julianday(excluded.sleep_end) > julianday(sleep_end) THEN excluded.sleep_end ELSE sleep_end END
              WHEN ${incomingLonger} THEN excluded.sleep_end
              ELSE sleep_end
            END,
            sleep_times_source = CASE
              WHEN ${keepStored} THEN sleep_times_source
              ELSE excluded.sleep_times_source
            END`;
}

module.exports = {
  SLEEP_BLOCK_GAP_HOURS,
  SLEEP_TIME_SOURCE_RANK,
  groupSleepBlocks,
  pickMainBlock,
  mainSleepBlocksByDay,
  ouraMainSleepTimes,
  sleepTimesUpdateSql
};

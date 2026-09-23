// Priority of ACTIVITY data sources (steps, calories, distance, active minutes).
//
// The problem this solves: three independent sources write to health_metrics - the Apple
// Health webhook/HealthKit, active polling of Google Fit, and active polling of Oura.
// Each upsert used to guard only against overwriting data from 'apple'
// (CASE WHEN activity_source = 'apple' ...), while Google Fit and Oura were treated as
// equals. The effect: for the same day the result depended on the ORDER of syncs within
// that hour - Oura could overwrite fresher step counts from Google Fit and vice versa, so
// the same date showed different numbers on successive refreshes.
//
// Hierarchy (highest first): apple > google_fit > oura.
// The reasoning is the same one the README gives for Apple Health: phone and watch
// sources report continuously, while Oura only finalises a day the next morning - so on
// conflict the phone data is closer to the truth.
// An unknown source (NULL, e.g. a row created solely by Withings) has rank 0, meaning any
// real activity source may fill it in.
const ACTIVITY_SOURCE_RANK = {
  apple: 3,
  google_fit: 2,
  oura: 1
};

// The activity columns the hierarchy governs. Every writer must decide the label from the
// same list, or two writers disagree about who owns a day and the label flips back and
// forth between syncs.
const ACTIVITY_METRIC_COLUMNS = [
  'steps', 'active_calories', 'total_calories_burned', 'active_minutes', 'distance_meters'
];

function getActivitySourceRank(source) {
  return ACTIVITY_SOURCE_RANK[source] || 0;
}

// PER-COLUMN PROVENANCE (audit 2026-09-23).
//
// Ownership used to be tracked once per ROW, in activity_source, and every column was
// assumed to belong to whoever that label named. The assumption is false whenever a source
// supplies only some of the columns, which is the normal case: Apple Health sends step
// count and distance from the phone while active calories arrive later from the watch, or
// not at all. The row was then labelled 'apple' and preserveHigherPriority() protected ALL
// five activity columns - including ones holding a Google Fit value that Apple had never
// written. Google Fit could no longer correct its own number: its fresh 300 kcal lost to a
// stale 200 kcal that Apple merely happened to be standing in front of.
//
// So each activity column carries its own `<column>_source`, written by whichever source
// actually supplied a value for it, and the guard consults that instead of the row label.
// The rule the two lines below encode: a higher-ranked source wins the columns IT
// SUPPLIES, and blocks nobody from filling the ones it leaves empty.
//
// activity_source stays as the row-level summary - the dashboard shows it as "data from
// Apple Health" - and is now derived from the per-column sources (see
// preserveSourceLabel), so the label can no longer claim a day the source does not own.
const sourceColumnOf = (column) => `${column}_source`;

// SQL fragment computing the rank of a stored source name. It is kept as a string because
// SQLite has no map or CASE-in-parameter - the list must be generated from the same
// constant as the JS side so the two cannot drift apart.
const rankSql = (sourceColumn) => `CASE ${sourceColumn} ${Object.entries(ACTIVITY_SOURCE_RANK)
  .map(([name, rank]) => `WHEN '${name}' THEN ${rank}`)
  .join(' ')} ELSE 0 END`;

/**
 * Builds the SQL for one activity metric column inside the ON CONFLICT ... DO UPDATE SET.
 *
 * Returns TWO assignments - the value column and its `<column>_source` companion. They are
 * emitted together on purpose: a caller that updated the value and forgot the provenance
 * would leave the column protected on behalf of a source that no longer wrote it, which is
 * exactly the bug this pair exists to prevent.
 *
 * Rule: keep the existing value only when THAT COLUMN was last written by a HIGHER-ranked
 * source AND it actually contains something (> 0). A higher source alone is not enough - a
 * day where Apple Health reported no distance should still be fillable from Oura, and a day
 * Apple wrote as zeros must not be pinned at zero for ever.
 *
 * All right-hand sides see the row as it was BEFORE the update (standard SQLite UPDATE
 * semantics), so the source column may be read after the value column is assigned above it.
 *
 * @param {string} column the column name (e.g. 'steps')
 * @param {number} incomingRank rank of the source currently writing
 */
function preserveHigherPriority(column, incomingRank) {
  const sourceColumn = sourceColumnOf(column);
  const protectedByHigherSource =
    `(${rankSql(sourceColumn)}) > ${incomingRank} AND COALESCE(${column}, 0) > 0`;
  return `${column} = CASE
              WHEN ${protectedByHigherSource} THEN ${column}
              ELSE COALESCE(excluded.${column}, ${column})
            END,
            ${sourceColumn} = CASE
              WHEN ${protectedByHigherSource} THEN ${sourceColumn}
              WHEN excluded.${column} IS NOT NULL THEN COALESCE(excluded.activity_source, ${sourceColumn})
              ELSE ${sourceColumn}
            END`;
}

/**
 * SQL expression for the activity_source column itself - the row-level summary of who owns
 * the day's activity.
 *
 * The label stays put exactly while at least one column is still protected: some column
 * holds real data and was written by a source outranking the one writing now. Otherwise the
 * incoming source takes the label, because it just overwrote everything worth owning.
 *
 * It is deliberately NOT decided by comparing the incoming rank against the OLD label any
 * more. That version kept the label on a source whose every column had since been replaced,
 * and - being the same expression the column guard used - it was what let a day labelled
 * 'apple' freeze columns Apple had never written.
 *
 * @param {number} incomingRank rank of the source currently writing
 * @param {string[]} columns columns that decide whether a previous source still "has data"
 */
function preserveSourceLabel(incomingRank, columns) {
  const stillProtected = columns
    .map(c => `((${rankSql(sourceColumnOf(c))}) > ${incomingRank} AND COALESCE(${c}, 0) > 0)`)
    .join(' OR ');
  return `activity_source = CASE
              WHEN ${stillProtected} THEN activity_source
              ELSE COALESCE(excluded.activity_source, activity_source)
            END`;
}

/**
 * The `<column>_source` column names, in the same order as `columns`.
 *
 * They have to appear in the INSERT as well as the DO UPDATE: on a row that does not exist
 * yet there is no conflict clause to run, and a new row left with NULL provenance would be
 * unowned - the next sync from a lower-ranked source would overwrite data it must not
 * touch, one hour after it was written.
 */
function activitySourceColumns(columns) {
  return columns.map(sourceColumnOf);
}

/**
 * The values to bind for activitySourceColumns(columns): the writing source's name for
 * every column this write actually carries, NULL for the ones it leaves empty.
 *
 * @param {Array<number|null|undefined>} values the bound values, in the same column order
 * @param {string|null} source the source doing the writing, or null when this payload
 *   brought no activity at all
 */
function activitySourceValues(values, source) {
  return values.map(value => (value === null || value === undefined ? null : source));
}

module.exports = {
  ACTIVITY_SOURCE_RANK,
  ACTIVITY_METRIC_COLUMNS,
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel,
  activitySourceColumns,
  activitySourceValues
};

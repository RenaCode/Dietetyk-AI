// Priority of ACTIVITY data sources (steps, calories, distance, active minutes).
//
// The problem this solves: three independent sources write to health_metrics - the Apple
// Health webhook/HealthKit, active polling of Google Fit, and active polling of Oura.
// Each upsert used to guard only
// przed nadpisaniem danych z 'apple' (CASE WHEN activity_source = 'apple' ...),
// while Google Fit and Oura were treated as equals. The effect: for the same day the
// result depended on the ORDER of syncs within that hour - Oura could overwrite fresher
// step counts from Google Fit and vice versa, so the same date showed different numbers
// on successive refreshes.
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

function getActivitySourceRank(source) {
  return ACTIVITY_SOURCE_RANK[source] || 0;
}

// SQL fragment computing the rank of the source ALREADY STORED in the row (the
// activity_source column). It is kept as a string because SQLite has no map or
// CASE-in-parameter - the list must be generated from the same constant as the JS side so
// the two cannot drift apart.
const EXISTING_RANK_SQL = `CASE activity_source ${Object.entries(ACTIVITY_SOURCE_RANK)
  .map(([name, rank]) => `WHEN '${name}' THEN ${rank}`)
  .join(' ')} ELSE 0 END`;

/**
 * Builds the SQL expression for one activity metric column inside the
 * ON CONFLICT ... DO UPDATE SET.
 *
 * Rule: keep the existing value only when the row's stored value comes from a
 * HIGHER-ranked source AND actually contains something (> 0). A higher source alone is
 * not enough - a day where Apple Health reported no distance should still be fillable
 * from Oura.
 *
 * @param {string} column nazwa kolumny (np. 'steps')
 * @param {number} incomingRank rank of the source currently writing
 */
function preserveHigherPriority(column, incomingRank) {
  return `${column} = CASE
              WHEN (${EXISTING_RANK_SQL}) > ${incomingRank} AND COALESCE(${column}, 0) > 0 THEN ${column}
              ELSE COALESCE(excluded.${column}, ${column})
            END`;
}

/**
 * SQL expression for the activity_source column itself: the label changes to the new
 * source only when something was actually overwritten. If the row belongs to a
 * higher-ranked source and holds any data in the given columns, the label stays - the
 * alternative is that a day "owned" by Apple Health gets silently relabelled 'oura'
 * merely because Oura contributed a metric Apple does not provide.
 *
 * @param {number} incomingRank rank of the source currently writing
 * @param {string[]} columns columns that decide whether the previous source "has data"
 */
function preserveSourceLabel(incomingRank, columns) {
  const hasData = columns.map(c => `COALESCE(${c}, 0) > 0`).join(' OR ');
  return `activity_source = CASE
              WHEN (${EXISTING_RANK_SQL}) > ${incomingRank} AND (${hasData}) THEN activity_source
              ELSE COALESCE(excluded.activity_source, activity_source)
            END`;
}

module.exports = {
  ACTIVITY_SOURCE_RANK,
  getActivitySourceRank,
  preserveHigherPriority,
  preserveSourceLabel
};

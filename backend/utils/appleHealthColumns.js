// Copies Apple Health daily values into the existing health_metrics columns that the
// Dashboard cards, insights (spo2-trend, early-strain-alert, bp-trend, sodium-bp,
// body-recomposition, weight-goal-forecast...), AI advice and reports already read.
//
// Why write into the columns rather than teach every reader about apple_health_hourly:
// those ~15 readers query health_metrics directly in SQL. Filling the column once, at write
// time, makes all of them use watch data with no change to any of them, and keeps one
// definition of "today's SpO2" instead of fifteen.
//
// SOURCE RULE. Each of these columns may also have an owner: Oura writes spo2_percentage and
// respiratory_rate (services/sync.js, Oura branch), Withings writes weight, fat_ratio and
// blood pressure (Withings branch). Both use COALESCE(excluded.x, x), so they overwrite
// whatever is there whenever they have a value. Apple writes a column when
//   - the user has no owner connected for it, or
//   - the column is empty (the owner delivered nothing that day - e.g. Oura without SpO2,
//     Withings before its scale synced), or
//   - the column still holds exactly the value Apple itself wrote last time (Apple refreshing
//     its own partial-day value), remembered in health_metrics.apple_columns_json.
// Once the owner writes a different value, the third condition fails and Apple never touches
// that column for that day again - so the sources cannot take turns overwriting each other,
// which the trend insights would read as day-to-day change.
//
// NO DUPLICATES (user request, 2026-10-02): every metric mapped here is shown through its
// regular Dashboard card and prompt line, so it is always left out of the "other metrics"
// list - see columnBackedMetrics. Before this, a user with Oura saw respiratory rate twice
// with two different numbers.
//
// This mirrors the has_oura rule the webhook already applies to sleep.

const { getDailyMetrics } = require('./appleHealthSamples');

// metric -> { column, owner, round }. `owner` is the oauth_tokens.service whose presence
// means the column belongs to someone else; null = Apple is the only writer.
const COLUMN_MAP = {
  blood_oxygen_saturation: { column: 'spo2_percentage', owner: 'oura', digits: 1 },
  respiratory_rate: { column: 'respiratory_rate', owner: 'oura', digits: 1 },
  blood_pressure_systolic: { column: 'blood_pressure_systolic', owner: 'withings', digits: 0 },
  blood_pressure_diastolic: { column: 'blood_pressure_diastolic', owner: 'withings', digits: 0 },
  weight_body_mass: { column: 'weight', owner: 'withings', digits: 2, toKg: true },
  body_fat_percentage: { column: 'fat_ratio', owner: 'withings', digits: 1 },
  // The phone's "Temperatura nadgarstka podczas snu Apple". The webhook's METRIC_FIELD_MAP
  // handles the name `wrist_temperature`, which was inferred, not observed; HealthKit calls
  // this type appleSleepingWristTemperature, so Health Auto Export most likely sends this
  // name and the column would otherwise stay empty.
  apple_sleeping_wrist_temperature: { column: 'wrist_temperature', owner: null, digits: 1 }
};

const LB_TO_KG = 0.45359237;

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function connectedServices(db, userId) {
  const rows = await db.all('SELECT service FROM oauth_tokens WHERE user_id = ?', [userId]);
  return new Set(rows.map((r) => r.service));
}

/**
 * Metrics shown through a health_metrics column and therefore left out of the "other
 * metrics" card and prompt line. Async and per-user for API stability; currently the same
 * set for everyone.
 */
async function columnBackedMetrics() {
  return new Set(Object.keys(COLUMN_MAP));
}

function sameValue(a, b) {
  return a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9;
}

/**
 * Recomputes the Apple-filled columns for the given dates from apple_health_hourly. Always
 * from the stored buckets, never from the request alone, so a payload carrying only part of a
 * day cannot shrink the value (same reasoning as the water re-sum in the webhook).
 */
async function syncAppleColumns(db, userId, dates) {
  const services = await connectedServices(db, userId);
  const columns = Object.values(COLUMN_MAP).map((spec) => spec.column);

  let updatedDays = 0;
  for (const date of dates) {
    const daily = await getDailyMetrics(db, userId, date, { excludeOwnColumns: false });
    const byMetric = new Map(daily.map((m) => [m.metric, m]));
    const current = await db.get(
      `SELECT ${columns.join(', ')}, apple_columns_json FROM health_metrics WHERE user_id = ? AND date = ?`,
      [userId, date]
    );
    let lastApple = {};
    try {
      lastApple = current && current.apple_columns_json ? JSON.parse(current.apple_columns_json) : {};
    } catch {
      lastApple = {};
    }

    const assignments = [];
    const values = [];
    for (const [metric, spec] of Object.entries(COLUMN_MAP)) {
      const m = byMetric.get(metric);
      if (!m) continue;
      const existing = current ? current[spec.column] : null;
      const ownerConnected = spec.owner && services.has(spec.owner);
      const mayWrite = !ownerConnected || existing == null || sameValue(existing, lastApple[spec.column]);
      if (!mayWrite) continue;
      let value = m.value;
      if (spec.toKg && /^(lb|lbs|pound)/i.test(m.units || '')) value *= LB_TO_KG;
      value = round(value, spec.digits);
      assignments.push(spec.column);
      values.push(value);
      lastApple[spec.column] = value;
    }
    if (assignments.length === 0) continue;
    await db.run(
      `INSERT INTO health_metrics (user_id, date, ${assignments.join(', ')}, apple_columns_json)
       VALUES (?, ?, ${assignments.map(() => '?').join(', ')}, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         ${assignments.map((c) => `${c} = excluded.${c}`).join(', ')},
         apple_columns_json = excluded.apple_columns_json`,
      [userId, date, ...values, JSON.stringify(lastApple)]
    );
    updatedDays++;
  }
  return updatedDays;
}

module.exports = {
  COLUMN_MAP,
  columnBackedMetrics,
  syncAppleColumns
};

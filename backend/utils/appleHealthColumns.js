// Copies Apple Health daily values into the existing health_metrics columns that the
// Dashboard cards, insights (spo2-trend, early-strain-alert, bp-trend, sodium-bp,
// body-recomposition, weight-goal-forecast...), AI advice and reports already read.
//
// Why write into the columns rather than teach every reader about apple_health_hourly:
// those ~15 readers query health_metrics directly in SQL. Filling the column once, at write
// time, makes all of them use watch data with no change to any of them, and keeps one
// definition of "today's SpO2" instead of fifteen.
//
// SOURCE RULE. Each of these columns already has an owner: Oura writes spo2_percentage and
// respiratory_rate (services/sync.js, Oura branch), Withings writes weight, fat_ratio and
// blood pressure (Withings branch). Both use COALESCE(excluded.x, x), so they overwrite
// whatever is there whenever they have a value. Apple therefore fills a column ONLY for a
// user who has no owner connected for it - otherwise the two sources would take turns
// overwriting each other depending on which synced last, and the trend insights would read
// the alternation as day-to-day change. For a user who HAS the owner connected, the watch
// value is not lost: it stays in apple_health_hourly and shows up in the "other metrics"
// card and the prompts (see columnBackedMetrics below).
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
 * Metrics whose daily value this user sees through a health_metrics column. The "other
 * metrics" card and prompt line leave them out so the same number is not shown twice.
 */
async function columnBackedMetrics(db, userId) {
  const services = await connectedServices(db, userId);
  return new Set(
    Object.entries(COLUMN_MAP)
      .filter(([, spec]) => !spec.owner || !services.has(spec.owner))
      .map(([metric]) => metric)
  );
}

/**
 * Recomputes the Apple-owned columns for the given dates from apple_health_hourly. Always
 * recomputed from the stored samples, never from the request alone, so a payload carrying
 * only part of a day cannot shrink the value (same reasoning as the water re-sum in the
 * webhook).
 */
async function syncAppleColumns(db, userId, dates) {
  const services = await connectedServices(db, userId);
  const owned = Object.entries(COLUMN_MAP).filter(([, spec]) => !spec.owner || !services.has(spec.owner));
  if (owned.length === 0) return 0;

  let updatedDays = 0;
  for (const date of dates) {
    const daily = await getDailyMetrics(db, userId, date, { excludeOwnColumns: false });
    const byMetric = new Map(daily.map((m) => [m.metric, m]));
    const assignments = [];
    const values = [];
    for (const [metric, spec] of owned) {
      const m = byMetric.get(metric);
      if (!m) continue;
      let value = m.value;
      if (spec.toKg && /^(lb|lbs|pound)/i.test(m.units || '')) value *= LB_TO_KG;
      assignments.push(spec.column);
      values.push(round(value, spec.digits));
    }
    if (assignments.length === 0) continue;
    await db.run(
      `INSERT INTO health_metrics (user_id, date, ${assignments.join(', ')})
       VALUES (?, ?, ${assignments.map(() => '?').join(', ')})
       ON CONFLICT(user_id, date) DO UPDATE SET
         ${assignments.map((c) => `${c} = excluded.${c}`).join(', ')}`,
      [userId, date, ...values]
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

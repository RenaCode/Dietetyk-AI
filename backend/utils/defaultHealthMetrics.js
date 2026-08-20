// Default health_metrics object - used as the fallback in routes/dashboard.js and
// routes/chat.js, gdy w bazie nie istnieje jeszcze wiersz health_metrics dla danej
// (user, data) - np. zanim pierwsza synchronizacja Oura/Withings/Apple Health danego
// before that day has any real data. Both files used to define this object
// independently, with slightly different fields - this is the UNION of every field used
// in either place (built on the more complete version from dashboard.js).
function getDefaultHealthMetrics() {
  return {
    steps: 0,
    active_calories: 0,
    total_calories_burned: 0,
    sleep_score: null,
    sleep_duration: null,
    sleep_deep: null,
    sleep_rem: null,
    readiness_score: null,
    hrv: null,
    rhr: null,
    temperature_deviation: null,
    respiratory_rate: null,
    spo2_percentage: null,
    wrist_temperature: null,
    weight: null,
    fat_ratio: null,
    muscle_mass: null,
    blood_pressure_systolic: null,
    blood_pressure_diastolic: null,
    active_minutes: 0,
    distance_meters: 0,
    sedentary_minutes: 0,
    low_activity_minutes: 0,
    stress_high_minutes: null,
    stress_recovery_minutes: null,
    stress_summary: null,
    water_ml: 0,
    last_sync: null,
    activity_source: null,
    ai_advice: null,
    ai_advice_generated_at: null
  };
}

module.exports = { getDefaultHealthMetrics };

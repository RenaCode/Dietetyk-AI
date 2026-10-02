// Event-type Health Auto Export payloads: symptoms, heart-rate notifications and cycle
// tracking. Unlike data.metrics[] these are not numeric series but discrete events with a
// start, an end, a name and a categorical value, and Health Auto Export sends each kind
// from its OWN automation, as data.symptoms[] / data.heartRateNotifications[] /
// data.cycleTracking[] with no data.metrics[] or data.workouts[] beside it. The webhook used
// to answer such a payload with a 400 ("expected data.metrics[] or data.workouts[]"), which
// the phone shows only as a generic "export failed".
//
// Formats, from the Health Auto Export help center (export-format/symptoms,
// /heart-rate-notifications, /cycle-tracking), dates as "yyyy-MM-dd HH:mm:ss Z":
//   symptoms:               { start, end, name: "Headache", severity: "Moderate", userEntered, source }
//   heartRateNotifications: { start, end, threshold?, heartRate: [{ hr, units, timestamp }],
//                             heartRateVariation: [{ hrv, units, timestamp }] }
//   cycleTracking:          { start, end, name: "Menstrual Flow", value: "Medium", isCycleStart? }
//   medications:            { displayText: "Magnez 400 mg", nickname?, form: "Tablet", dosage?,
//                             status: "Taken" | "Skipped" | "Not Logged" | ..., start,
//                             scheduledDate?, isArchived, codings: [{ code, system }] }

const crypto = require('crypto');
const { recomputeSupplements, MAX_SUPPLEMENTS_LENGTH } = require('./supplementsMerge');
const {
  parseHealthAutoExportDate,
  dateObjToLocalDateString,
  getLocalDateString
} = require('./dates');

const EVENT_KINDS = {
  symptoms: 'symptom',
  heartRateNotifications: 'heart_rate_notification',
  cycleTracking: 'cycle',
  medications: 'medication'
};

// Names and values come straight from the request body. The webhook is authenticated only by
// the sync token in its URL, and these strings end up in Gemini prompts and on the Dashboard,
// so a leaked token must not be able to plant instructions ("ignore previous instructions...")
// or markup. Real values are short HealthKit enum names ("Lower Back Pain", "Egg White",
// "Positive/Peak"), so a tight whitelist and a length cap lose nothing genuine.
const MAX_TEXT_LENGTH = 60;
function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\p{L}\p{N} .,'/()+-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_TEXT_LENGTH) : null;
}

function numbers(list, field) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => (x && typeof x === 'object' ? Number(x[field]) : NaN))
    .filter(Number.isFinite);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Summarises a heart-rate notification. The payload does not say WHICH notification it was;
 * Apple sends a threshold only for high/low heart rate, so the direction is inferred from
 * whether the recorded rate sat above or below it. No threshold means an irregular-rhythm
 * notification. The raw sample arrays are reduced to min/avg/max rather than stored: they
 * can hold hundreds of points and nothing reads them individually.
 */
function summariseHeartRateNotification(entry) {
  const hr = numbers(entry.heartRate, 'hr');
  const hrv = numbers(entry.heartRateVariation, 'hrv');
  const threshold = Number.isFinite(Number(entry.threshold)) ? Number(entry.threshold) : null;
  const details = {
    threshold,
    hr_min: hr.length ? Math.min(...hr) : null,
    hr_max: hr.length ? Math.max(...hr) : null,
    hr_avg: hr.length ? round1(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
    hrv_avg: hrv.length ? round1(hrv.reduce((a, b) => a + b, 0) / hrv.length) : null
  };
  let name = 'Irregular Rhythm';
  if (threshold !== null) {
    const reference = details.hr_avg !== null ? details.hr_avg : threshold;
    name = reference >= threshold ? 'High Heart Rate' : 'Low Heart Rate';
  }
  const value = details.hr_max !== null
    ? (name === 'Low Heart Rate' ? `${details.hr_min} bpm` : `${details.hr_max} bpm`)
    : null;
  return { name, value, details };
}

/**
 * Turns data.symptoms / data.heartRateNotifications / data.cycleTracking into flat rows.
 * @returns {Array<{kind, eventKey, start, end, date, name, value, details}>}
 */
function extractEvents(data) {
  const events = [];
  if (!data || typeof data !== 'object') return events;

  for (const [field, kind] of Object.entries(EVENT_KINDS)) {
    const list = data[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      // A medication entry is one dose: `start` is when the medication was first added (it
      // can be years ago) and `scheduledDate` is the dose this status belongs to. Dating the
      // dose by `start` would file every "Taken" under the day the pill was set up.
      const whenRaw = kind === 'medication' ? (entry.scheduledDate || entry.start) : entry.start;
      const startParsed = parseHealthAutoExportDate(whenRaw);
      if (!startParsed) continue;
      const endParsed = kind === 'medication' ? null : parseHealthAutoExportDate(entry.end);

      let name;
      let value;
      let details = null;
      if (kind === 'heart_rate_notification') {
        ({ name, value, details } = summariseHeartRateNotification(entry));
      } else if (kind === 'symptom') {
        name = cleanText(entry.name);
        value = cleanText(entry.severity);
      } else if (kind === 'medication') {
        name = cleanText(entry.displayText);
        value = cleanText(entry.status);
        const coding = Array.isArray(entry.codings) ? entry.codings.find((c) => c && c.code) : null;
        details = {
          nickname: cleanText(entry.nickname),
          form: cleanText(entry.form),
          dosage: Number.isFinite(Number(entry.dosage)) ? Number(entry.dosage) : null,
          code: coding ? cleanText(String(coding.code)) : null,
          archived: entry.isArchived === true
        };
      } else {
        name = cleanText(entry.name);
        value = cleanText(entry.value);
        if (entry.isCycleStart === true) details = { isCycleStart: true };
      }
      if (!name) continue;

      const start = startParsed.toISOString();
      // Keyed by the instant (ISO, so two spellings of the same moment collapse into one) and
      // the name: re-sending an export replaces the event - a symptom whose severity the user
      // edited is updated, not duplicated. A hash keeps the key short and uniform.
      const eventKey = crypto.createHash('sha256').update(`${kind}|${start}|${name}`).digest('hex').slice(0, 32);
      events.push({
        kind,
        eventKey,
        start,
        end: endParsed ? endParsed.toISOString() : null,
        date: dateObjToLocalDateString(startParsed),
        name,
        value,
        details
      });
    }
  }
  return events;
}

async function storeEvents(db, userId, events) {
  for (const e of events) {
    await db.run(
      `INSERT OR REPLACE INTO apple_health_events
         (user_id, event_key, kind, start, end, date, name, value, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, e.eventKey, e.kind, e.start, e.end, e.date, e.name, e.value,
        e.details ? JSON.stringify(e.details) : null]
    );
  }
}

/**
 * Rebuilds health_metrics.supplements_apple - the medications ticked "Taken" in Apple Health
 * that day - for the given dates, then the merged `supplements` column (see
 * utils/supplementsMerge.js). Always from the stored events, so a dose un-ticked on the phone
 * and re-exported disappears instead of lingering.
 */
async function syncMedicationSupplements(db, userId, dates) {
  for (const date of dates) {
    const rows = await db.all(
      `SELECT DISTINCT name FROM apple_health_events
       WHERE user_id = ? AND kind = 'medication' AND date = ? AND value = 'Taken'
       ORDER BY name`,
      [userId, date]
    );
    const list = rows.map((r) => r.name).join(', ').slice(0, MAX_SUPPLEMENTS_LENGTH) || null;
    await db.run(
      `INSERT INTO health_metrics (user_id, date, supplements_apple) VALUES (?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET supplements_apple = excluded.supplements_apple`,
      [userId, date, list]
    );
    await recomputeSupplements(db, userId, date);
  }
}

// Polish labels for what Apple Health sends in English. Anything missing is shown as sent -
// a readable English name beats hiding the event.
const NAME_LABELS = {
  // heart-rate notifications (names assigned in summariseHeartRateNotification)
  'High Heart Rate': 'Wysokie tętno',
  'Low Heart Rate': 'Niskie tętno',
  'Irregular Rhythm': 'Nieregularny rytm serca',
  // cycle tracking
  'Menstrual Flow': 'Miesiączka',
  'Intermenstrual Bleeding': 'Plamienie międzymiesiączkowe',
  'Cervical Mucus Quality': 'Śluz szyjkowy',
  'Ovulation Test Result': 'Test owulacyjny',
  'Basal Body Temperature': 'Temperatura podstawowa',
  'Sexual Activity': 'Aktywność seksualna',
  Contraceptive: 'Antykoncepcja',
  Pregnancy: 'Ciąża',
  Lactation: 'Laktacja',
  // symptoms (HealthKit category names, as Health Auto Export spells them)
  Headache: 'Ból głowy',
  Fatigue: 'Zmęczenie',
  Nausea: 'Nudności',
  Fever: 'Gorączka',
  Bloating: 'Wzdęcia',
  'Abdominal Cramps': 'Skurcze brzucha',
  'Lower Back Pain': 'Ból dolnej części pleców',
  'Mood Changes': 'Wahania nastroju',
  Acne: 'Trądzik',
  'Appetite Changes': 'Zmiany apetytu',
  'Breast Pain': 'Ból piersi',
  'Sleep Changes': 'Zmiany snu',
  Constipation: 'Zaparcia',
  Diarrhea: 'Biegunka',
  Heartburn: 'Zgaga',
  Dizziness: 'Zawroty głowy',
  'Hot Flashes': 'Uderzenia gorąca',
  'Night Sweats': 'Nocne poty',
  Chills: 'Dreszcze',
  Coughing: 'Kaszel',
  'Sore Throat': 'Ból gardła',
  'Runny Nose': 'Katar',
  'Shortness Of Breath': 'Duszności',
  'Shortness of Breath': 'Duszności',
  Wheezing: 'Świszczący oddech',
  Vomiting: 'Wymioty',
  'Loss Of Smell': 'Utrata węchu',
  'Loss Of Taste': 'Utrata smaku',
  'Rapid Pounding Or Fluttering Heartbeat': 'Kołatanie serca',
  'Skipped Heartbeat': 'Przeskakujące bicie serca',
  'Chest Tightness Or Pain': 'Ucisk lub ból w klatce',
  'Body And Muscle Ache': 'Bóle mięśni',
  'Generalized Body Ache': 'Bóle mięśni',
  Fainting: 'Omdlenie',
  'Memory Lapse': 'Problemy z pamięcią',
  'Hair Loss': 'Wypadanie włosów',
  'Dry Skin': 'Sucha skóra',
  'Bladder Incontinence': 'Nietrzymanie moczu',
  'Pelvic Pain': 'Ból miednicy',
  'Vaginal Dryness': 'Suchość pochwy'
};

const VALUE_LABELS = {
  Taken: 'przyjęte',
  Skipped: 'pominięte',
  Snoozed: 'odłożone',
  'Not Logged': 'niezalogowane',
  'Not Interacted': 'niezalogowane',
  'Notification Not Sent': 'niezalogowane',
  Mild: 'łagodne',
  Moderate: 'umiarkowane',
  Severe: 'silne',
  Present: 'wystąpiło',
  'Not Present': 'nie wystąpiło',
  Unspecified: 'nieokreślone',
  None: 'brak',
  Light: 'lekka',
  Medium: 'średnia',
  Heavy: 'obfita'
};

// A symptom logged as "Not Present" or a flow of "None" is the user recording an ABSENCE.
// Telling the model "Headache: not present" costs prompt space and invites it to comment on
// a headache nobody had.
const ABSENCE_VALUES = new Set(['Not Present', 'None']);

function describe(e) {
  return {
    kind: e.kind,
    name: e.name,
    label: NAME_LABELS[e.name] || e.name,
    value: e.value,
    valueLabel: e.value ? (VALUE_LABELS[e.value] || e.value) : null,
    start: e.start,
    end: e.end,
    details: e.details_json ? JSON.parse(e.details_json) : null
  };
}

// Cycle lengths outside 21-40 days are treated as a missed or extra log rather than a real
// cycle (the clinical "normal" range is 21-35; 40 leaves room for an occasional long one).
// Averaging them in would push every phase estimate off by days.
const MIN_CYCLE_DAYS = 21;
const MAX_CYCLE_DAYS = 40;
const DEFAULT_CYCLE_DAYS = 28;
const DEFAULT_PERIOD_DAYS = 5;
// The luteal phase is the stable part of the cycle (about 14 days); variation in cycle length
// comes from the follicular phase. Ovulation is therefore estimated as cycleLength - 14,
// which is the standard calendar-method approximation, not a measurement.
const LUTEAL_DAYS = 14;

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * Cycle position for `date`, from the user's own Menstrual Flow history.
 *
 * Returns null when there is no cycle start in the last 60 days - an older start says
 * nothing reliable about today's phase, it means tracking stopped.
 *
 * `estimated` is true when the cycle length is the 28-day default rather than the user's own
 * average (fewer than two complete cycles logged): the phase is then a rough guide only, and
 * the UI and prompts say so.
 */
async function getCycleDay(db, userId, date) {
  const starts = (await db.all(
    `SELECT DISTINCT date FROM apple_health_events
     WHERE user_id = ? AND kind = 'cycle' AND name = 'Menstrual Flow'
       AND details_json LIKE '%"isCycleStart":true%'
       AND date <= ? AND date >= date(?, '-365 days')
     ORDER BY date ASC`,
    [userId, date, date]
  )).map((r) => r.date);
  if (starts.length === 0) return null;
  const cycleStart = starts[starts.length - 1];
  if (daysBetween(cycleStart, date) > 60) return null;

  const lengths = [];
  for (let i = 1; i < starts.length; i++) {
    const len = daysBetween(starts[i - 1], starts[i]);
    if (len >= MIN_CYCLE_DAYS && len <= MAX_CYCLE_DAYS) lengths.push(len);
  }
  const estimated = lengths.length === 0;
  const cycleLength = estimated
    ? DEFAULT_CYCLE_DAYS
    : Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);

  // Period length of the current cycle: logged flow days (anything but "None") from the start.
  const flowDays = await db.all(
    `SELECT DISTINCT date FROM apple_health_events
     WHERE user_id = ? AND kind = 'cycle' AND name = 'Menstrual Flow'
       AND COALESCE(value, '') != 'None' AND date >= ? AND date <= date(?, '+10 days')
     ORDER BY date ASC`,
    [userId, cycleStart, cycleStart]
  );
  let periodDays = 0;
  for (const row of flowDays) {
    if (daysBetween(cycleStart, row.date) === periodDays) periodDays++;
    else break;
  }
  if (periodDays === 0) periodDays = DEFAULT_PERIOD_DAYS;

  const day = daysBetween(cycleStart, date) + 1;
  const ovulationDay = cycleLength - LUTEAL_DAYS;
  let phase;
  if (day <= periodDays) phase = 'menstrual';
  else if (day < ovulationDay - 1) phase = 'follicular';
  else if (day <= ovulationDay + 1) phase = 'ovulation';
  else if (day <= cycleLength) phase = 'luteal';
  else phase = 'late';

  return { day, cycleStart, cycleLength, periodDays, phase, estimated };
}

const PHASE_TEXT = {
  pl: {
    menstrual: {
      label: 'Miesiączka',
      note: 'Utrata krwi zwiększa zapotrzebowanie na żelazo - warto sięgać po mięso, jaja, rośliny strączkowe razem z witaminą C. Gorsze samopoczucie i niższa energia w treningu są w tych dniach typowe.'
    },
    follicular: {
      label: 'Faza folikularna',
      note: 'Zwykle najlepszy okres na intensywniejsze treningi i stabilne odczyty wagi.'
    },
    ovulation: {
      label: 'Okolice owulacji',
      note: 'Waga i apetyt zwykle stabilne; przed fazą lutealną warto zaplanować posiłki z większą ilością białka i błonnika.'
    },
    luteal: {
      label: 'Faza lutealna',
      note: 'Waga bywa przejściowo wyższa o 0,5-2 kg przez zatrzymanie wody, a apetyt większy - nie oceniaj postępu po pojedynczych ważeniach z tych dni.'
    },
    late: {
      label: 'Cykl dłuższy niż zwykle',
      note: 'Cykl trwa dłużej niż Twoja średnia. Jeśli to nie brak wpisu w Zdrowiu, waga może być podwyższona przez zatrzymanie wody.'
    }
  },
  en: {
    menstrual: { label: 'Menstruation', note: 'Blood loss raises iron needs - meat, eggs, legumes with vitamin C help. Lower energy in training is typical these days.' },
    follicular: { label: 'Follicular phase', note: 'Usually the best window for harder training and stable weight readings.' },
    ovulation: { label: 'Around ovulation', note: 'Weight and appetite are usually stable; plan protein- and fibre-rich meals ahead of the luteal phase.' },
    luteal: { label: 'Luteal phase', note: 'Weight is often 0.5-2 kg higher from water retention and appetite larger - do not judge progress by single weigh-ins from these days.' },
    late: { label: 'Longer cycle than usual', note: 'The cycle is running longer than your average. Unless a log is missing, weight may be raised by water retention.' }
  }
};

function describeCycle(cycle, language = 'pl') {
  if (!cycle) return null;
  const t = PHASE_TEXT[language === 'en' ? 'en' : 'pl'][cycle.phase];
  return { ...cycle, phaseLabel: t.label, note: t.note };
}

/**
 * Heart-rate notifications from the `days` days up to and including `date`. Apple raises
 * them for sustained high or low rate while INACTIVE and for irregular rhythm, so they are
 * worth surfacing even once - but they are the watch's screening signal, not a diagnosis, and
 * the card wording must say so.
 */
async function getHeartRateNotifications(db, userId, date, days = 7) {
  const rows = await db.all(
    `SELECT name, value, start, details_json FROM apple_health_events
     WHERE user_id = ? AND kind = 'heart_rate_notification'
       AND date <= ? AND date > date(?, ?)
     ORDER BY start DESC`,
    [userId, date, date, `-${days} days`]
  );
  return rows.map(describe);
}

async function getDailyEvents(db, userId, date = getLocalDateString()) {
  const rows = await db.all(
    `SELECT kind, name, value, start, end, details_json FROM apple_health_events
     WHERE user_id = ? AND date = ?
     ORDER BY start`,
    [userId, date]
  );
  return {
    events: rows.map(describe),
    cycle: await getCycleDay(db, userId, date)
  };
}

/**
 * Everything the Dashboard needs about the day's events, with Polish/English text resolved.
 */
async function getDailyEventsView(db, userId, date, language = 'pl') {
  const { events, cycle } = await getDailyEvents(db, userId, date);
  return {
    events,
    cycle: describeCycle(cycle, language),
    heartRateNotifications: await getHeartRateNotifications(db, userId, date)
  };
}

const KIND_PREFIX = {
  pl: { symptom: 'Objawy', heart_rate_notification: 'Powiadomienia o tętnie', cycle: 'Cykl', medication: 'Pominięte dawki leków/suplementów' },
  en: { symptom: 'Symptoms', heart_rate_notification: 'Heart rate notifications', cycle: 'Cycle', medication: 'Skipped medication/supplement doses' }
};

/**
 * Prompt lines for the day's events, or null. English names go to the English prompt and
 * Polish labels to the Polish one.
 */
function formatDailyEventsForPrompt({ events, cycle }, language = 'pl') {
  const lang = language === 'en' ? 'en' : 'pl';
  const lines = [];
  for (const kind of Object.keys(KIND_PREFIX[lang])) {
    const items = events
      .filter((e) => e.kind === kind && !ABSENCE_VALUES.has(e.value))
      // Taken medications already reach the prompt through the supplements line (the
      // merged health_metrics.supplements column); listing them here again would show the
      // model every pill twice. Only doses the user explicitly skipped are worth adding.
      .filter((e) => e.kind !== 'medication' || e.value === 'Skipped')
      .map((e) => {
        const name = lang === 'en' ? e.name : e.label;
        const value = lang === 'en' ? e.value : e.valueLabel;
        return value ? `${name} (${value})` : name;
      });
    if (items.length > 0) lines.push(`- ${KIND_PREFIX[lang][kind]}: ${items.join(', ')}`);
  }
  if (cycle) {
    const d = describeCycle(cycle, lang);
    const approx = cycle.estimated
      ? (lang === 'en' ? ', phase estimated from a default 28-day cycle' : ', faza szacowana z domyślnego cyklu 28 dni')
      : (lang === 'en' ? `, average cycle ${cycle.cycleLength} days` : `, średni cykl ${cycle.cycleLength} dni`);
    lines.push(lang === 'en'
      ? `- Menstrual cycle: day ${cycle.day}, ${d.phaseLabel} (cycle started ${cycle.cycleStart}${approx}). ${d.note}`
      : `- Cykl miesiączkowy: dzień ${cycle.day}, ${d.phaseLabel} (początek cyklu ${cycle.cycleStart}${approx}). ${d.note}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

module.exports = {
  EVENT_KINDS,
  extractEvents,
  storeEvents,
  getDailyEvents,
  getCycleDay,
  describeCycle,
  getHeartRateNotifications,
  getDailyEventsView,
  syncMedicationSupplements,
  formatDailyEventsForPrompt,
  cleanText
};

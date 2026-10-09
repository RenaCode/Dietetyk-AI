const PDFDocument = require('pdfkit');
const db = require('../db');
const path = require('path');
const { getUserSettings, aggregateNutritionAndHealth } = require('./summaries');
const { getLocalDateString, shiftDate } = require('../utils/dates');

// PDF export for a doctor or dietician - a document the user downloads themselves and shows
// to a professional. Deliberately WITHOUT any Gemini-generated text (unlike the summary
// emails in the same module): this is a quasi-medical document, so it contains only raw,
// computed data from the application (the same sources as the email reports), with no risk
// of the language model 'adding' something the user never logged. It uses only data the app
// already collects - no new fields or forms.
const PDF_REPORT_MAX_DAYS = 180;
const PDF_REPORT_DEFAULT_DAYS = 30;

// Body circumference labels - identical to ActivityTracker.jsx (getMeasureLabel), so the
// PDF report names the same measurements the same way the frontend does.
const MEASUREMENT_FIELDS = [
  ['chest', 'Klatka piersiowa'],
  ['shoulders', 'Barki'],
  ['waist', 'Talia / Pas'],
  ['waist_above', 'Pas +2cm'],
  ['waist_below', 'Pas -2cm'],
  ['hips', 'Biodra'],
  ['biceps', 'Biceps'],
  ['biceps_left', 'Biceps lewy'],
  ['biceps_right', 'Biceps prawy'],
  ['thigh', 'Udo']
];

// The report's date window as Warsaw calendar dates, through utils/dates.js - not
// toISOString(), which is UTC. Between 00:00 and 02:00 Warsaw time the UTC date is still
// yesterday's, so a report generated then labelled its period a day early and its window
// started a day early: every `date` column in the database is a Warsaw date (see CLAUDE.md,
// "Dates"). Exported for tests/test-pdf-report-window.js.
//
// `endDate` freezes the window for a shared link (B-S3, see services/sharedReports.js); a
// download from Settings passes none and ends today. A frozen end date in the future of
// "today" cannot happen through the app, and is clamped anyway.
function reportWindow(days, endDate) {
  const localToday = getLocalDateString();
  const today = typeof endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate < localToday
    ? endDate
    : localToday;
  return { startDate: shiftDate(today, -days), today };
}

async function buildHealthReportPdf(userId, requestedDays, { endDate } = {}) {
  const days = Math.min(Math.max(parseInt(requestedDays, 10) || PDF_REPORT_DEFAULT_DAYS, 1), PDF_REPORT_MAX_DAYS);

  const user = await db.get(
    `SELECT username, first_name, last_name, body_goal_text FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const settings = await getUserSettings(userId);
  const { startDate, today } = reportWindow(days, endDate);

    // The same tables and columns as the email reports (summaries.js) - without image_base64
    // or analysis_json, which this report never displays.
  const [meals, healthMetrics, bodyMeasurements] = await Promise.all([
    // `date` is NOT an unused column here, however much it looks like one next to seven
    // values that are only ever summed. aggregateNutritionAndHealth divides every nutrition
    // total by the number of DISTINCT m.date values, so a SELECT without it makes the
    // divisor 1 and turns "average daily intake" into the sum of the whole window - up to
    // 180 days of meals reported to a doctor as a single day's eating. The same column was
    // dropped from the weekly and monthly report queries for the same reason and with the
    // same result (tests/test-summary-aggregation.js); summaries.js now rejects rows without
    // it rather than averaging them, and tests/test-pdf-report.js pins the figure here.
    db.all(
      `SELECT date, calories, protein, carbs, fat, fiber, sugar, sodium FROM meals WHERE user_id = ? AND date >= ? AND date <= ?`,
      [userId, startDate, today]
    ),
    db.all(`SELECT * FROM health_metrics WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`, [userId, startDate, today]),
    db.all(`SELECT * FROM body_measurements WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`, [userId, startDate, today])
  ]);

  // `userId` and `startDate` are passed so workoutsCount is counted from apple_health_workouts,
  // exactly as the weekly and monthly e-mail reports and routes/dashboard.js do it. Omitting
  // them silently selects the fallback branch in aggregateNutritionAndHealth - days where
  // active_calories > 0 - which is the measure audit round 12 REJECTED: it scores a day with
  // three workouts as one, and misses strength training done without a watch entirely. So the
  // document going to a doctor was showing the number this project had already thrown out,
  // while the e-mail reports built from the same data showed the corrected one. Same failure
  // shape as the missing `date` above: a fix applied at one call site, another left behind.
  //
  // await, because aggregateNutritionAndHealth is async (it may query apple_health_workouts).
  // Without it `stats` was a Promise: every stats.avg* below read as undefined and the
  // document handed to a doctor printed "Energia: undefined kcal" on every averages line,
  // while still generating, downloading and opening like a valid report. Nothing else here
  // would have caught it - the missing rejection handling made it worse rather than louder,
  // since server.js's unhandledRejection handler logs and returns instead of exiting.
  const stats = await aggregateNutritionAndHealth(meals, healthMetrics, days, userId, startDate, today);
  const firstMeasurement = bodyMeasurements.length > 0 ? bodyMeasurements[0] : null;
  const lastMeasurement = bodyMeasurements.length > 0 ? bodyMeasurements[bodyMeasurements.length - 1] : null;

  return new Promise((resolve, reject) => {
  // Declared before the try so the catch can clean up (doc.destroy()) if an error occurs
  // AFTER the document was created - inside .text(), for instance.
    let doc;
    try {
      doc = new PDFDocument({ margin: 50, size: 'A4' });
      doc.registerFont('Roboto', path.join(__dirname, '../assets/fonts/Roboto-Regular.ttf'));
      doc.registerFont('Roboto-Bold', path.join(__dirname, '../assets/fonts/Roboto-Bold.ttf'));
      doc.font('Roboto');

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const sectionTitle = (text) => {
        doc.moveDown(0.8);
        doc.fontSize(13).fillColor('#1e293b').font('Roboto-Bold').text(text);
        doc.moveDown(0.3);
        doc.fontSize(10).fillColor('#0f172a').font('Roboto');
      };
      const row = (label, value) => {
        doc.text(`${label}: ${value}`);
      };

    // --- Header ---
      doc.fontSize(20).fillColor('#1e293b').font('Roboto-Bold').text('Dietetyk AI - Raport zdrowotno-żywieniowy');
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#64748b').font('Roboto');
      doc.text(`Pacjent: ${[user.first_name, user.last_name].filter(Boolean).join(' ') || user.username} (login: ${user.username})`);
      doc.text(`Okres raportu: ${startDate} - ${today} (${days} dni)`);
      doc.text(`Wygenerowano: ${new Date().toLocaleString('pl-PL')}`);

      // --- Cele ---
      sectionTitle('Cele dobowe');
      row('Cel kaloryczny', `${settings.targetCalories} kcal`);
      row('Makroskładniki', `Białko ${settings.targetProtein} g, Węglowodany ${settings.targetCarbs} g, Tłuszcz ${settings.targetFat} g`);
      row('BMR (podstawowa przemiana materii)', `${settings.bmr} kcal`);
      row('Cel nawodnienia', `${settings.targetWaterMl} ml`);
      if (settings.targetWeightKg) {
        row('Docelowa waga', `${settings.targetWeightKg} kg`);
      }

    // --- Period averages ---
      sectionTitle(`Średnie dzienne z okresu (${days} dni, wyłącznie dni z zalogowanymi danymi)`);
      row('Energia', `${stats.avgEatenCalories} kcal`);
      row('Białko / Węglowodany / Tłuszcz', `${stats.avgProtein} g / ${stats.avgCarbs} g / ${stats.avgFat} g`);
      row('Błonnik / Cukry / Sód', `${stats.avgFiber} g / ${stats.avgSugar} g / ${stats.avgSodium} mg`);
      row('Kroki', `${stats.avgSteps}`);
      row('Aktywne kalorie spalone', `${stats.avgActiveCalories} kcal`);
      row('Nawodnienie', `${stats.avgWaterMl} ml`);
      // "Treningi", not "dni z treningiem": since the call above counts rows in
      // apple_health_workouts, the figure is the number of WORKOUTS in the period, and two
      // sessions in one day count as two. The wording follows the e-mail reports' own tables
      // ("Treningi w tygodniu" / "Treningi w miesiącu" in services/summaries.js), so the same
      // number is not given two different names in two documents the patient may show side
      // by side.
      row('Treningi w okresie', `${stats.workoutsCount}`);

    // --- Sleep, recovery, body composition ---
      sectionTitle('Sen, regeneracja i skład ciała (Oura / Withings)');
      row('Średni wynik snu', stats.avgSleepScore !== null ? `${stats.avgSleepScore}/100` : 'brak danych');
      row('Średni wynik gotowości', stats.avgReadinessScore !== null ? `${stats.avgReadinessScore}/100` : 'brak danych');
      row('Średnia waga ciała', stats.avgWeight !== null ? `${stats.avgWeight} kg` : 'brak danych');
      if (stats.weightChange !== null) {
        row('Zmiana wagi w okresie', `${stats.weightChange > 0 ? '+' : ''}${stats.weightChange} kg`);
      }
      row('Średni procent tkanki tłuszczowej', stats.avgFatRatio !== null ? `${stats.avgFatRatio}%` : 'brak danych');
      if (stats.fatRatioChange !== null) {
        row('Zmiana % tkanki tłuszczowej', `${stats.fatRatioChange > 0 ? '+' : ''}${stats.fatRatioChange} pp`);
      }
      row('Średnia masa mięśniowa', stats.avgMuscleMass !== null ? `${stats.avgMuscleMass} kg` : 'brak danych');
      if (stats.muscleMassChange !== null) {
        row('Zmiana masy mięśniowej', `${stats.muscleMassChange > 0 ? '+' : ''}${stats.muscleMassChange} kg`);
      }
      row(
        'Średnie ciśnienie tętnicze',
        stats.avgBpSystolic !== null ? `${stats.avgBpSystolic}/${stats.avgBpDiastolic} mmHg` : 'brak danych'
      );

    // --- Body circumference measurements ---
      if (firstMeasurement && lastMeasurement) {
        sectionTitle('Pomiary obwodów ciała (pierwszy vs ostatni pomiar w okresie)');
        row('Data pierwszego / ostatniego pomiaru', `${firstMeasurement.date} / ${lastMeasurement.date}`);
        MEASUREMENT_FIELDS.forEach(([key, label]) => {
          const startVal = firstMeasurement[key];
          const endVal = lastMeasurement[key];
          if (startVal !== null && startVal !== undefined && endVal !== null && endVal !== undefined) {
            const diff = Math.round((endVal - startVal) * 10) / 10;
            row(label, `${startVal} cm -> ${endVal} cm (${diff > 0 ? '+' : ''}${diff} cm)`);
          }
        });
      }

      // --- Suplementy ---
      if (stats.supplementsLogged.length > 0) {
        sectionTitle('Suplementy zapisane w okresie');
      // Capped at 30 entries - with the maximum 180-day window the list could get very long,
      // and this is still meant to be a concise document to show a doctor.
        stats.supplementsLogged.slice(0, 30).forEach((s) => doc.text(`- ${s}`));
        if (stats.supplementsLogged.length > 30) {
          doc.text(`... oraz ${stats.supplementsLogged.length - 30} kolejnych wpisów.`);
        }
      }

      // --- Opisany cel sylwetki ---
      if (user.body_goal_text) {
        sectionTitle('Opisany cel sylwetki użytkownika');
        doc.text(user.body_goal_text, { width: 495 });
      }

    // --- Disclaimer ---
      doc.moveDown(1.5);
      doc.fontSize(8).fillColor('#94a3b8').text(
        'Dokument wygenerowany automatycznie przez aplikację Dietetyk AI na podstawie danych samodzielnie wprowadzanych i synchronizowanych przez użytkownika (m.in. Oura, Withings, Apple Health). Nie stanowi diagnozy medycznej ani porady lekarskiej - ma charakter wyłącznie informacyjny, jako materiał pomocniczy do rozmowy z lekarzem lub dietetykiem.',
        { width: 495 }
      );

      doc.end();
    } catch (err) {
    // The stream writes to an in-memory buffer rather than a file, so nothing really 'leaks'
    // without destroy() - this is just a tidy close of the stream, so it is not left in an
    // undefined state after an error while building the PDF.
      if (doc) doc.destroy();
      reject(err);
    }
  });
}

module.exports = { buildHealthReportPdf, reportWindow, PDF_REPORT_MAX_DAYS, PDF_REPORT_DEFAULT_DAYS };

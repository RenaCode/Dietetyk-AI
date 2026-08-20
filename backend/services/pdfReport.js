const PDFDocument = require('pdfkit');
const db = require('../db');
const path = require('path');
const { getUserSettings, aggregateNutritionAndHealth } = require('./summaries');

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

async function buildHealthReportPdf(userId, requestedDays) {
  const days = Math.min(Math.max(parseInt(requestedDays, 10) || PDF_REPORT_DEFAULT_DAYS, 1), PDF_REPORT_MAX_DAYS);

  const user = await db.get(
    `SELECT username, first_name, last_name, body_goal_text FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) {
    throw new Error('Użytkownik nie istnieje.');
  }

  const settings = await getUserSettings(userId);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

    // The same tables and columns as the email reports (summaries.js) - without image_base64
    // or analysis_json, which this report never displays.
  const [meals, healthMetrics, bodyMeasurements] = await Promise.all([
    db.all(
      `SELECT calories, protein, carbs, fat, fiber, sugar, sodium FROM meals WHERE user_id = ? AND date >= ?`,
      [userId, startDate]
    ),
    db.all(`SELECT * FROM health_metrics WHERE user_id = ? AND date >= ? ORDER BY date ASC`, [userId, startDate]),
    db.all(`SELECT * FROM body_measurements WHERE user_id = ? AND date >= ? ORDER BY date ASC`, [userId, startDate])
  ]);

  const stats = aggregateNutritionAndHealth(meals, healthMetrics, days);
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
      row('Liczba dni z treningiem', `${stats.workoutsCount}`);

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

      // --- Supplements ---
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

module.exports = { buildHealthReportPdf, PDF_REPORT_MAX_DAYS, PDF_REPORT_DEFAULT_DAYS };

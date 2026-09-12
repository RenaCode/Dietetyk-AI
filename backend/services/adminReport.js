const db = require('../db');
const { sendMailgunEmail } = require('./mailgun');

// Simple email address format validation (round 17, an audit fix) - before
// sending, we filter out addresses that do not even look like an email (a typo saved earlier
// in an admin profile, say), so we do not attempt delivery to an obviously broken address and
// do not clutter the logs with Mailgun errors for obvious cases.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Generates and sends the weekly security and error report to administrators.
 */
async function sendWeeklyAdminReport() {
  console.log('[ADMIN REPORT] Starting the log report generation...');

  try {
    // 1. Fetch every active admin who has an email address
    const admins = await db.all(`SELECT id, username, email FROM users WHERE role = 'admin' AND status = 'active'`);
    const adminEmails = admins
      .map(a => a.email)
      .filter(Boolean)
      .filter(email => {
        if (!EMAIL_REGEX.test(email)) {
          console.warn(`[ADMIN REPORT] Pomijam nieprawidłowy adres e-mail administratora: ${email}`);
          return false;
        }
        return true;
      });

    if (adminEmails.length === 0) {
      console.warn('[ADMIN REPORT] No active administrators with a valid email address. Skipping delivery.');
      return;
    }

    // 2. Fetch overall statistics (log counts by level over the last 7 days)
    const counts = await db.all(`
      SELECT level, COUNT(*) as count 
      FROM app_logs 
      WHERE timestamp >= datetime('now', '-7 days', 'localtime') 
      GROUP BY level
    `);
    
    const stats = { INFO: 0, WARN: 0, ERROR: 0, SECURITY: 0 };
    counts.forEach(r => {
      if (stats[r.level] !== undefined) {
        stats[r.level] = r.count;
      }
    });

    // 3. Fetch the top 10 most frequent errors (ERROR) from the last 7 days
    const topErrors = await db.all(`
      SELECT message, category, COUNT(*) as count 
      FROM app_logs 
      WHERE level = 'ERROR' AND timestamp >= datetime('now', '-7 days', 'localtime') 
      GROUP BY message, category 
      ORDER BY count DESC 
      LIMIT 10
    `);

    // 4. Fetch the top 10 most frequent security incidents (SECURITY) from the last 7 days
    const topSecurity = await db.all(`
      SELECT message, category, COUNT(*) as count 
      FROM app_logs 
      WHERE level = 'SECURITY' AND timestamp >= datetime('now', '-7 days', 'localtime') 
      GROUP BY message, category 
      ORDER BY count DESC 
      LIMIT 10
    `);

    // 5. Fetch the 20 most recent WARN, ERROR or SECURITY log entries
    const recentLogs = await db.all(`
      SELECT timestamp, level, category, message, ip, details 
      FROM app_logs 
      WHERE level IN ('ERROR', 'SECURITY', 'WARN') AND timestamp >= datetime('now', '-7 days', 'localtime') 
      ORDER BY timestamp DESC 
      LIMIT 20
    `);

    // 6. Wygeneruj szablon HTML
    const html = generateReportHtml(stats, topErrors, topSecurity, recentLogs);

    // 7. Send the email to each admin
    for (const email of adminEmails) {
      try {
        await sendMailgunEmail({
          to: email,
          subject: `Dietetyk AI - Cotygodniowy Raport Logów i Bezpieczeństwa`,
          html: html
        });
        console.log(`[ADMIN REPORT] Raport wysłany pomyślnie na adres: ${email}`);
      } catch (sendErr) {
        console.error(`[ADMIN REPORT ERROR] Błąd podczas wysyłania e-maila do ${email}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error('[ADMIN REPORT ERROR] Failed to generate the log report:', err.message);
    throw err;
  }
}

/**
 * Helper for formatting the report HTML
 */
function generateReportHtml(stats, topErrors, topSecurity, recentLogs) {
  const totalLogs = stats.INFO + stats.WARN + stats.ERROR + stats.SECURITY;
  
// Row formatting for the tables
  const topErrorsRows = topErrors.length > 0 
    ? topErrors.map(e => `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px;"><strong>${escapeHtml(e.category)}</strong></td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #e53e3e;">${escapeHtml(e.message)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align: center;"><strong>${e.count}</strong></td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" style="padding: 15px; text-align: center; color: #718096; font-size: 14px;">Brak błędów w wybranym okresie.</td></tr>';

  const topSecurityRows = topSecurity.length > 0
    ? topSecurity.map(s => `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px;"><strong>${escapeHtml(s.category)}</strong></td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #805ad5;">${escapeHtml(s.message)}</td>
          <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align: center;"><strong>${s.count}</strong></td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" style="padding: 15px; text-align: center; color: #718096; font-size: 14px;">Brak incydentów bezpieczeństwa.</td></tr>';

  const recentLogsRows = recentLogs.length > 0
    ? recentLogs.map(l => {
        let badgeColor = '#4a5568';
        if (l.level === 'ERROR') badgeColor = '#e53e3e';
        if (l.level === 'WARN') badgeColor = '#dd6b20';
        if (l.level === 'SECURITY') badgeColor = '#805ad5';

        const detailsText = l.details 
          ? `<details style="margin-top: 5px; cursor: pointer;">
               <summary style="font-size: 12px; color: #4a5568;">Pokaż szczegóły</summary>
               <pre style="background: #f7fafc; padding: 8px; border-radius: 4px; font-size: 11px; white-space: pre-wrap; overflow-x: auto; margin: 5px 0 0 0;">${escapeHtml(l.details)}</pre>
             </details>` 
          : '';

        return `
          <tr style="vertical-align: top;">
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; white-space: nowrap; color: #718096;">${l.timestamp}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px;">
              <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; color: #fff; background-color: ${badgeColor}; font-weight: bold; font-size: 10px;">${l.level}</span>
            </td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; font-weight: bold;">${escapeHtml(l.category)}</td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">
              <div>${escapeHtml(l.message)}</div>
              ${detailsText}
            </td>
            <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #4a5568; font-family: monospace;">${escapeHtml(l.ip || '-')}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="5" style="padding: 15px; text-align: center; color: #718096; font-size: 14px;">Brak ważnych logów w tym okresie.</td></tr>';

  return `
    <!DOCTYPE html>
    <html lang="pl">
    <head>
      <meta charset="UTF-8">
      <title>Raport Logów i Bezpieczeństwa</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f7fafc; margin: 0; padding: 20px; color: #2d3748;">
      <div style="max-width: 900px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); overflow: hidden;">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #1a202c 0%, #2d3748 100%); color: #ffffff; padding: 30px; text-align: center;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">🛡️ Dietetyk AI</h1>
          <p style="margin: 5px 0 0 0; color: #a0aec0; font-size: 16px;">Tygodniowy Raport Logów i Monitorowania Bezpieczeństwa</p>
          <div style="display: inline-block; margin-top: 15px; font-size: 12px; background: rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 12px; color: #e2e8f0;">
            Wygenerowano: ${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}
          </div>
        </div>

        <div style="padding: 30px;">
          
          <!-- Podsumowanie liczbowe -->
          <h2 style="font-size: 18px; border-bottom: 2px solid #edf2f7; padding-bottom: 8px; margin-top: 0;">📊 Podsumowanie zdarzeń (ostatnie 7 dni)</h2>
          <div style="display: flex; gap: 15px; margin-bottom: 30px; flex-wrap: wrap;">
            
            <div style="flex: 1; min-width: 150px; background: #ebf8ff; border-left: 4px solid #3182ce; padding: 15px; border-radius: 4px;">
              <div style="font-size: 12px; color: #2b6cb0; text-transform: uppercase; font-weight: bold;">Łącznie</div>
              <div style="font-size: 24px; font-weight: bold; margin-top: 5px;">${totalLogs}</div>
            </div>
            
            <div style="flex: 1; min-width: 150px; background: #fed7d7; border-left: 4px solid #e53e3e; padding: 15px; border-radius: 4px;">
              <div style="font-size: 12px; color: #9b2c2c; text-transform: uppercase; font-weight: bold;">Błędy (ERROR)</div>
              <div style="font-size: 24px; font-weight: bold; margin-top: 5px; color: #c53030;">${stats.ERROR}</div>
            </div>

            <div style="flex: 1; min-width: 150px; background: #faf5ff; border-left: 4px solid #805ad5; padding: 15px; border-radius: 4px;">
              <div style="font-size: 12px; color: #553c9a; text-transform: uppercase; font-weight: bold;">Bezpieczeństwo</div>
              <div style="font-size: 24px; font-weight: bold; margin-top: 5px; color: #6b46c1;">${stats.SECURITY}</div>
            </div>

            <div style="flex: 1; min-width: 150px; background: #feebc8; border-left: 4px solid #dd6b20; padding: 15px; border-radius: 4px;">
              <div style="font-size: 12px; color: #9c4221; text-transform: uppercase; font-weight: bold;">Ostrzeżenia (WARN)</div>
              <div style="font-size: 24px; font-weight: bold; margin-top: 5px; color: #dd6b20;">${stats.WARN}</div>
            </div>
          </div>

          <!-- TOP 10 BŁĘDÓW -->
          <div style="margin-bottom: 30px;">
            <h2 style="font-size: 18px; border-bottom: 2px solid #edf2f7; padding-bottom: 8px;">❌ Powtarzające się błędy (Top 10)</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: #f7fafc; text-align: left;">
                  <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; width: 120px;">Kategoria</th>
                  <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568;">Wiadomość błędu</th>
                  <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; text-align: center; width: 80px;">Wystąpienia</th>
                </tr>
              </thead>
              <tbody>
                ${topErrorsRows}
              </tbody>
            </table>
          </div>

          <!-- TOP 10 BEZPIECZEŃSTWO -->
          <div style="margin-bottom: 30px;">
            <h2 style="font-size: 18px; border-bottom: 2px solid #edf2f7; padding-bottom: 8px;">🛡️ Incydenty i limity bezpieczeństwa (Top 10)</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: #f7fafc; text-align: left;">
                  <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; width: 120px;">Kategoria</th>
                  <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568;">Zdarzenie</th>
                  <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; text-align: center; width: 80px;">Wystąpienia</th>
                </tr>
              </thead>
              <tbody>
                ${topSecurityRows}
              </tbody>
            </table>
          </div>

          <!-- OSTATNIE 20 LOGÓW -->
          <div>
            <h2 style="font-size: 18px; border-bottom: 2px solid #edf2f7; padding-bottom: 8px;">📋 Ostatnie istotne zdarzenia (ERROR/WARN/SECURITY)</h2>
            <div style="overflow-x: auto;">
              <table style="width: 100%; border-collapse: collapse; min-width: 700px;">
                <thead>
                  <tr style="background: #f7fafc; text-align: left;">
                    <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; width: 130px;">Czas</th>
                    <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; width: 70px;">Poziom</th>
                    <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; width: 100px;">Kategoria</th>
                    <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568;">Opis zdarzenia / błędu</th>
                    <th style="padding: 10px; border-bottom: 2px solid #cbd5e0; font-size: 12px; text-transform: uppercase; color: #4a5568; width: 110px;">Adres IP</th>
                  </tr>
                </thead>
                <tbody>
                  ${recentLogsRows}
                </tbody>
              </table>
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div style="background: #edf2f7; padding: 20px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #e2e8f0;">
          Wiadomość wygenerowana automatycznie przez system Dietetyk AI.<br>
          Nie odpowiadaj na tego e-maila. W razie problemów skontaktuj się z administratorem systemu.
        </div>

      </div>
    </body>
    </html>
  `;
}

/**
 * Protection against XSS attacks in the HTML reports
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { sendWeeklyAdminReport };

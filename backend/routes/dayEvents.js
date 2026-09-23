const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isCalendarDateString } = require('../utils/dates');

// "Day tag" - the user marks a date range with context (illness/holiday/late bedtime) so
// that selected dashboard insights can exclude those days from
// the baseline/norm calculation (see the date-exclusion helper in dashboard.js). `type`
// is a closed enum - insights map specific types to specific exclusions, so arbitrary
// free text here would break that logic.
const VALID_TYPES = ['illness', 'vacation', 'late_sleep'];

// Calendar validation, not just the shape. This used to be a bare
// /^\d{4}-\d{2}-\d{2}$/ with a comment arguing that checking whether the date really
// exists "is not worth the extra complexity for this form", because SQLite compares such
// values lexicographically correctly for range queries. The first half of that was true
// and the second half stopped being true:
//
//   - the shape test accepts 2026-13-45 and 2026-02-30. Nothing rejects them, so the tag
//     is stored and simply never matches a real day - a range the user set and that
//     silently covers nothing;
//   - worse, these values do not stay inside range queries. Insights read day tags and
//     feed the dates into calendar arithmetic (shiftDate), where Date.UTC happily rolls
//     2026-02-30 forward to March 2 - so the excluded window moves without a word;
//   - "extra complexity" is now one shared import. isCalendarDateString lives in
//     utils/dates.js, which this backend already depends on everywhere.
//
// This was the sixth copy of the same weaker rule found on 2026-09-23 (chat.js,
// dashboard.js x2, appleHealth.js, mealAnomaly.js and here). The other five were
// duplicated arithmetic; this one had a reasoned justification that outlived the
// conditions that made it reasonable - which is the harder kind to notice.

const MAX_NOTE_LENGTH = 500;

// The user's day events, most recent (by start_date) first.
router.get('/api/day-events', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT id, type, start_date, end_date, note, created_at
      FROM day_events
      WHERE user_id = ?
      ORDER BY start_date DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd pobierania zdarzeń dnia.' });
  }
});

// Dodanie nowego zdarzenia (zakres dat + typ + opcjonalna notatka).
router.post('/api/day-events', requireAuth, async (req, res) => {
  const { type, start_date, end_date, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Nieprawidłowy typ zdarzenia. Dozwolone: ${VALID_TYPES.join(', ')}.` });
  }
  if (!isCalendarDateString(start_date) || !isCalendarDateString(end_date)) {
    return res.status(400).json({ error: 'Daty muszą być w formacie RRRR-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ error: 'Data końcowa nie może być wcześniejsza niż data początkowa.' });
  }

  const trimmedNote = note ? String(note).trim() : null;
  if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `Notatka jest za długa (maks. ${MAX_NOTE_LENGTH} znaków).` });
  }

  try {
    const result = await db.run(`
      INSERT INTO day_events (user_id, type, start_date, end_date, note)
      VALUES (?, ?, ?, ?, ?)
    `, [req.user.id, type, start_date, end_date, trimmedNote || null]);
    res.json({
      id: result.id,
      type,
      start_date,
      end_date,
      note: trimmedNote || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd zapisu zdarzenia dnia.' });
  }
});

// Editing an existing event - the same validation as on creation, and likewise restricted
// to one's own (WHERE user_id = ? prevents editing another user's event by guessing or
// walking ids).
router.put('/api/day-events/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Nieprawidłowe id zdarzenia.' });
  }

  const { type, start_date, end_date, note } = req.body;

  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `Nieprawidłowy typ zdarzenia. Dozwolone: ${VALID_TYPES.join(', ')}.` });
  }
  if (!isCalendarDateString(start_date) || !isCalendarDateString(end_date)) {
    return res.status(400).json({ error: 'Daty muszą być w formacie RRRR-MM-DD.' });
  }
  if (end_date < start_date) {
    return res.status(400).json({ error: 'Data końcowa nie może być wcześniejsza niż data początkowa.' });
  }

  const trimmedNote = note ? String(note).trim() : null;
  if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `Notatka jest za długa (maks. ${MAX_NOTE_LENGTH} znaków).` });
  }

  try {
    const result = await db.run(`
      UPDATE day_events
      SET type = ?, start_date = ?, end_date = ?, note = ?
      WHERE id = ? AND user_id = ?
    `, [type, start_date, end_date, trimmedNote || null, id, req.user.id]);

    if (!result.changes) {
      return res.status(404).json({ error: 'Zdarzenie nie zostało znalezione.' });
    }

    res.json({
      id,
      type,
      start_date,
      end_date,
      note: trimmedNote || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd edycji zdarzenia dnia.' });
  }
});

// Deleting an event - one's own only (WHERE user_id = ? prevents deleting another user's
// event by guessing or walking ids).
router.delete('/api/day-events/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Nieprawidłowe id zdarzenia.' });
  }
  try {
    const result = await db.run(`DELETE FROM day_events WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!result.changes) {
      return res.status(404).json({ error: 'Zdarzenie nie zostało znalezione.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Błąd usuwania zdarzenia dnia.' });
  }
});

module.exports = router;

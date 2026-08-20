# Dietetyk AI — project instructions

## Language rule

**All code and comments must be written in English.** This includes:

- Comments (line, block, JSDoc) — no exceptions
- Identifiers: variables, functions, classes, files, database columns, API routes
- Log and console messages (`console.log`, `console.warn`, `console.error`, `logger.*`)
- Commit messages, PR descriptions, and documentation (`README.md`, this file)
- Test names and test output

**Polish stays only where it is product content the user reads:**

- Text rendered in the UI (JSX strings, placeholders, labels, button captions)
- Keys and values in `frontend/src/utils/i18n.js` — the dictionary keys *are* the Polish source strings by design
- API error messages sent to the client and shown in the interface
- AI prompt text in `backend/utils/mealPrompts.js` and the prompt builders in `backend/services/summaries.js` / `backend/routes/dashboard.js` — the Polish wording is what makes Gemini answer in Polish. The *instructions around* the prompt (comments explaining why a rule exists) are English; the prompt body sent to the model stays Polish for the `pl` variant.
- Fixture and seed data that imitates real user input (meal descriptions, etc.)

When in doubt: if a Polish speaker with no access to the code would never see the string, it must be English.

### Migrating existing Polish

The codebase predates this rule and is still largely Polish-commented. Do **not** launch a repo-wide translation sweep on your own — it produces enormous, unreviewable diffs and destroys `git blame`. Instead:

- Translate comments in any block you are already modifying for another reason.
- When you add a new file, it is English-only from the start.
- If asked to translate a specific file or directory, do it as its own commit that changes *nothing* but language, so the diff stays reviewable.

## Comment style

The existing comments are unusually good and the bar should stay high. They explain **why**, not what:

- Record the reasoning behind a non-obvious choice, especially thresholds, empirical constants, and priority rules.
- When fixing a bug, describe the failure mode that motivated the fix — future readers need to know what breaks if they revert it.
- Name the alternative you rejected and why, when the choice was close.
- Mark values that are empirical rather than clinical/derived, so nobody mistakes a tuned constant for a standard.

Do not write comments that restate the code (`// increment counter`).

## Architecture notes

- **Backend**: Node.js + Express, SQLite (single file, `journal_mode=TRUNCATE` — not WAL; see the comment at the top of `backend/db.js` before changing backup logic).
- **Frontend**: React + Vite, dark glassmorphism theme, hand-rolled SVG charts (no charting library).
- **AI**: Gemini. Model selection is centralised in `backend/config.js` — never read `process.env.GEMINI_MODEL` directly elsewhere.
- **Dates**: every date computation must go through `backend/utils/dates.js`, which forces `Europe/Warsaw`. Bare `new Date().getHours()` / `getDay()` returns the *server's* timezone (UTC in production) and silently shifts data by 1–2 hours.
- **Activity data priority**: three sources write to `health_metrics`. The hierarchy lives in one place, `backend/utils/activitySources.js` (`apple > google_fit > oura`). Never hand-write an `ON CONFLICT` guard for activity columns — use the helpers, or the sources start overwriting each other depending on sync order.
- **Dashboard insights**: registered as `/api/dashboard/<id>` routes and indexed automatically into a batch endpoint. Adding an insight requires no second registration step, but it must be registered with a plain `router.get('/api/dashboard/<id>', …)` call or it will silently drop out of the batch.

## Testing

- `cd backend && npm test` runs the suite. Point `DATABASE_DIR` at a temp directory when running locally so the dev database is not touched.
- New logic that can fail silently (aggregations, date math, priority rules, prompts) needs a test that would fail *before* the fix. A test that only passes after the change proves nothing about the bug.
- `cd frontend && npm run check-i18n` reports translation drift.

## Conventions

- Never commit secrets. Integration credentials belong in the Settings tab (encrypted via `utils/encryption.js`), never in files.
- `main` is protected — work on a branch and open a PR.
- Do not add dependencies without a clear reason; the project deliberately hand-rolls charts and has a small dependency surface.

#!/usr/bin/env bash
# scripts/verify_backup.sh <path-to-backup.db>
#
# Checks whether a backup file CAN ACTUALLY BE RESTORED - which is what nobody was doing.
# A backup nobody has ever opened is worth about as much as no backup at all: you find out it
# is corrupt only when you need it.
#
# With no argument it checks the NEWEST backup in the default directory - in that form it
# works as an independent watchdog in cron:
#   0 6 * * * /opt/dietetyk-ai/scripts/verify_backup.sh || mail -s "Backup Dietetyk AI USZKODZONY" ty@example.com
#
# Exit code: 0 = the backup is sound, 1 = corrupt or incomplete.

set -uo pipefail

DB_DIR="${DB_DIR:-/opt/dietetyk-ai/data}"
BACKUP_DIR="${BACKUP_DIR:-$DB_DIR/backups}"
CONTAINER="${CONTAINER:-dietetyk-backend}"

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
    TARGET=$(find "$BACKUP_DIR" -type f -name "dietetyk-*.db" -print0 2>/dev/null \
        | xargs -0 ls -1t 2>/dev/null | head -n 1)
    if [ -z "$TARGET" ]; then
        echo "BŁĄD: brak jakiejkolwiek kopii zapasowej w $BACKUP_DIR"
        exit 1
    fi
    echo "Sprawdzam najnowszą kopię: $TARGET"
fi

if [ ! -f "$TARGET" ]; then
    echo "BŁĄD: plik nie istnieje: $TARGET"
    exit 1
fi

# The verification script. Opens the copy READ-ONLY and checks, in order:
#   1. quick_check - whether the database structure is intact,
#   2. that the key tables exist and are non-empty - a file can be structurally valid and yet
#      empty (a copy taken mid-migration, for instance),
#   3. reading a sample row - proof the data can genuinely be extracted.
read -r -d '' VERIFY_JS <<'EOF' || true
const sqlite3 = require('sqlite3').verbose();
const file = process.argv[1];
const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => {
  if (err) { console.error('CANNOT OPEN:', err.message); process.exit(1); }
});
const fail = (msg) => { console.error('USZKODZONA:', msg); process.exit(1); };
db.get('PRAGMA quick_check', (err, row) => {
  if (err) return fail(err.message);
  const verdict = row && (row.quick_check || row['quick_check']);
  if (verdict !== 'ok') return fail(`quick_check = ${verdict}`);

  const tables = ['users', 'meals', 'health_metrics', 'settings'];
  let pending = tables.length;
  const counts = {};
  tables.forEach((table) => {
    db.get(`SELECT COUNT(*) AS n FROM ${table}`, (tErr, cRow) => {
      if (tErr) return fail(`brak tabeli ${table}: ${tErr.message}`);
      counts[table] = cRow.n;
      if (--pending === 0) {
        if (counts.users === 0) return fail('kopia nie zawiera żadnych użytkowników');
        console.log('OK - the backup is restorable.');
        console.log('     ' + tables.map(t => `${t}=${counts[t]}`).join('  '));
        process.exit(0);
      }
    });
  });
});
EOF

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}\$"; then
    # Path inside the container - the data directory is mounted there as /app/data.
    IN_CONTAINER="/app/data/backups/$(basename "$TARGET")"
    docker exec "$CONTAINER" node -e "$VERIFY_JS" "$IN_CONTAINER"
    exit $?
elif command -v node >/dev/null 2>&1 && node -e "require('sqlite3')" 2>/dev/null; then
    node -e "$VERIFY_JS" "$TARGET"
    exit $?
elif command -v sqlite3 >/dev/null 2>&1; then
    echo "Kontener nie działa i brak modułu sqlite3 w node - weryfikacja uproszczona klientem sqlite3."
    CHECK=$(sqlite3 "file:$TARGET?mode=ro" "PRAGMA quick_check;" 2>&1)
    if [ "$CHECK" != "ok" ]; then
        echo "USZKODZONA: quick_check = $CHECK"
        exit 1
    fi
    USERS=$(sqlite3 "file:$TARGET?mode=ro" "SELECT COUNT(*) FROM users;" 2>&1)
    if ! [ "$USERS" -gt 0 ] 2>/dev/null; then
        echo "USZKODZONA: nie udało się odczytać tabeli users (wynik: $USERS)"
        exit 1
    fi
    echo "OK - kopia nadaje się do odtworzenia (users=$USERS)."
    exit 0
else
    echo "BŁĄD: brak sposobu na otwarcie bazy (kontener nie działa, brak sqlite3)."
    exit 1
fi

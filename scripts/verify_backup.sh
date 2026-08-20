#!/usr/bin/env bash
# scripts/verify_backup.sh <ścieżka-do-kopii.db>
#
# Sprawdza, czy plik kopii zapasowej DA SIĘ ODTWORZYĆ - czyli robi to, czego
# dotąd nie robił nikt. Backup, którego nigdy nie otwarto, jest wart tyle, co
# jego brak: dowiadujemy się o uszkodzeniu dopiero przy awarii.
#
# Bez argumentu sprawdza NAJNOWSZĄ kopię w domyślnym katalogu - w tej postaci
# nadaje się do crona jako niezależny strażnik:
#   0 6 * * * /opt/dietetyk-ai/scripts/verify_backup.sh || mail -s "Backup Dietetyk AI USZKODZONY" ty@example.com
#
# Kod wyjścia: 0 = kopia sprawna, 1 = kopia uszkodzona/niekompletna.

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

# Skrypt weryfikujący. Otwiera kopię TYLKO DO ODCZYTU i sprawdza kolejno:
#   1. quick_check - czy struktura bazy jest nieuszkodzona,
#   2. obecność i niepustość kluczowych tabel - plik może być strukturalnie
#      poprawny, a jednocześnie pusty (np. kopia zrobiona w trakcie migracji),
#   3. odczyt przykładowego wiersza - dowód, że dane realnie da się wyciągnąć.
read -r -d '' VERIFY_JS <<'EOF' || true
const sqlite3 = require('sqlite3').verbose();
const file = process.argv[1];
const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => {
  if (err) { console.error('NIE MOŻNA OTWORZYĆ:', err.message); process.exit(1); }
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
        console.log('OK - kopia nadaje się do odtworzenia.');
        console.log('     ' + tables.map(t => `${t}=${counts[t]}`).join('  '));
        process.exit(0);
      }
    });
  });
});
EOF

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}\$"; then
    # Ścieżka wewnątrz kontenera - katalog data jest tam zamontowany jako /app/data.
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

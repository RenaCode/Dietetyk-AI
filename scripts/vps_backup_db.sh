#!/usr/bin/env bash
# scripts/vps_backup_db.sh
#
# Backup of the production SQLite database on the VPS: creation, VERIFICATION,
# opcjonalne zgranie poza serwer i rotacja.
#
# Cron roota (codziennie o 3:00):
#   0 3 * * * /opt/dietetyk-ai/scripts/vps_backup_db.sh >> /var/log/db_backup.log 2>&1
#
# Shipping off-site (without this the copies sit on the SAME disk as the database and do not
# protect against host failure - set the variable and add an SSH key):
#   OFFSITE_DEST=user@backup-host:/backups/dietetyk-ai/ /opt/dietetyk-ai/scripts/vps_backup_db.sh
#
# WHAT CHANGED from the previous version of this script, and why:
#  1. `cp` of a live .db file was replaced with `VACUUM INTO`. Plainly copying a file the
#     backend may be writing to can produce a copy truncated mid-transaction - the file
#     exists, has a plausible size, and cannot be restored. VACUUM INTO writes a consistent
#     image of the database inside a transaction.
#  2. `PRAGMA wal_checkpoint(FULL)` was removed. The database runs in journal_mode TRUNCATE,
#     not WAL (see the comment at the top of backend/db.js) - that checkpoint was a no-op and
#     created a false impression that the copy was safeguarded.
#  3. Backup verification was added (quick_check plus a user count). Rotation runs ONLY after
#     a successful verification, so a run of failed backups can never delete the last good
#     copies.

set -euo pipefail

# --- KONFIGURACJA ---
DB_DIR="${DB_DIR:-/opt/dietetyk-ai/data}"
DB_FILE="$DB_DIR/dietetyk.db"
BACKUP_DIR="${BACKUP_DIR:-$DB_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
CONTAINER="${CONTAINER:-dietetyk-backend}"
# Cel zgrywania poza serwer (rsync). Puste = pomijamy ten krok.
OFFSITE_DEST="${OFFSITE_DEST:-}"
# ---------------------

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/dietetyk-vps-$TIMESTAMP.db"

echo "=== [$(date)] Rozpoczęcie tworzenia kopii zapasowej ==="

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
    echo "BŁĄD: Plik bazy danych nie istnieje pod ścieżką: $DB_FILE"
    exit 1
fi

# The copy and its verification run through node inside the backend container, which has the
# sqlite3 module installed - so the host does not need an sqlite3 client. When the container
# is not running, we fall back to a local `sqlite3`.
run_in_container() {
    docker exec "$CONTAINER" node -e "$1"
}

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
    echo "Tworzenie spójnej kopii (VACUUM INTO) przez kontener $CONTAINER..."
    run_in_container "
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('/app/data/dietetyk.db');
        db.run('VACUUM INTO ?', ['/app/data/backups/dietetyk-vps-${TIMESTAMP}.db'], (err) => {
            if (err) { console.error('VACUUM INTO FAILED:', err.message); process.exit(1); }
            console.log('Kopia zapisana.');
            db.close();
        });
    "
elif command -v sqlite3 >/dev/null 2>&1; then
    echo "Kontener nie działa - tworzenie kopii lokalnym klientem sqlite3..."
    sqlite3 "$DB_FILE" "VACUUM INTO '$BACKUP_FILE'"
else
    echo "BŁĄD: kontener $CONTAINER nie działa i brak klienta sqlite3 na hoście."
    echo "      Nie wykonuję kopii przez 'cp' - kopiowanie żywej bazy potrafi dać plik nieodtwarzalny."
    exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
    echo "BŁĄD: kopia nie powstała pod ścieżką $BACKUP_FILE"
    exit 1
fi

# --- WERYFIKACJA ---
# A copy nobody has ever opened is not a backup - it is a file.
echo "Weryfikacja kopii..."
if ! "$(dirname "$0")/verify_backup.sh" "$BACKUP_FILE"; then
    echo "BŁĄD: kopia nie przeszła weryfikacji - usuwam ją i ZACHOWUJĘ poprzednie."
    rm -f "$BACKUP_FILE"
    exit 1
fi

chmod 600 "$BACKUP_FILE"
if [ "$(id -u)" -eq 0 ]; then
    chown deploy:deploy "$BACKUP_FILE" 2>/dev/null || true
fi

echo "Kopia zapasowa utworzona i zweryfikowana: $BACKUP_FILE"

# --- ZGRANIE POZA SERWER ---
if [ -n "$OFFSITE_DEST" ]; then
    echo "Zgrywanie poza serwer do: $OFFSITE_DEST"
    if rsync -a --chmod=F600 "$BACKUP_FILE" "$OFFSITE_DEST"; then
        echo "Zgrano poza serwer."
    else
        # We deliberately do NOT abort: the local copy is valid and already verified, so an
        # unreachable backup host should not look like a failed backup. But it must be loudly
        # visible in the log.
        echo "OSTRZEŻENIE: zgrywanie poza serwer NIE POWIODŁO SIĘ. Kopia istnieje tylko lokalnie!"
    fi
else
    echo "OSTRZEŻENIE: OFFSITE_DEST nie ustawione - kopie leżą na tym samym dysku co baza."
    echo "             Awaria dysku/hosta zabierze jednocześnie bazę i wszystkie kopie."
fi

# --- ROTACJA (dopiero po udanej weryfikacji) ---
echo "Czyszczenie kopii starszych niż $RETENTION_DAYS dni..."
find "$BACKUP_DIR" -type f -name "dietetyk-*.db" -mtime +"$RETENTION_DAYS" -print -delete

echo "=== [$(date)] Backup zakończony pomyślnie. ==="
echo ""

#!/usr/bin/env bash
# scripts/vps_backup_db.sh
#
# Kopia zapasowa produkcyjnej bazy SQLite na VPS: wykonanie, WERYFIKACJA,
# opcjonalne zgranie poza serwer i rotacja.
#
# Cron roota (codziennie o 3:00):
#   0 3 * * * /opt/dietetyk-ai/scripts/vps_backup_db.sh >> /var/log/db_backup.log 2>&1
#
# Zgrywanie poza serwer (bez tego kopie leżą na TYM SAMYM dysku co baza i nie
# chronią przed awarią hosta - ustaw zmienną i dodaj klucz SSH):
#   OFFSITE_DEST=user@backup-host:/backups/dietetyk-ai/ /opt/dietetyk-ai/scripts/vps_backup_db.sh
#
# CO SIĘ ZMIENIŁO wzgl. poprzedniej wersji tego skryptu i dlaczego:
#  1. `cp` żywego pliku .db zastąpione przez `VACUUM INTO`. Zwykłe kopiowanie pliku,
#     do którego backend może akurat pisać, potrafi dać kopię uciętą w połowie
#     transakcji - plik istnieje, ma sensowny rozmiar, a nie da się go odtworzyć.
#     VACUUM INTO zapisuje spójny obraz bazy w ramach transakcji.
#  2. Usunięty `PRAGMA wal_checkpoint(FULL)`. Baza działa w journal_mode TRUNCATE,
#     nie WAL (patrz komentarz na początku backend/db.js) - ten checkpoint był
#     no-opem i tworzył fałszywe wrażenie, że kopia jest zabezpieczona.
#  3. Dodana weryfikacja kopii (quick_check + liczba użytkowników). Rotacja
#     wykonuje się WYŁĄCZNIE po udanej weryfikacji, żeby seria nieudanych backupów
#     nigdy nie skasowała ostatnich dobrych kopii.

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

# Kopię i weryfikację wykonujemy przez node z kontenera backendu - ma zainstalowany
# moduł sqlite3, więc na hoście nie musi być klienta sqlite3. Gdy kontener nie
# działa, próbujemy lokalnego `sqlite3` jako wariantu awaryjnego.
run_in_container() {
    docker exec "$CONTAINER" node -e "$1"
}

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
    echo "Tworzenie spójnej kopii (VACUUM INTO) przez kontener $CONTAINER..."
    run_in_container "
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database('/app/data/dietetyk.db');
        db.run('VACUUM INTO ?', ['/app/data/backups/dietetyk-vps-${TIMESTAMP}.db'], (err) => {
            if (err) { console.error('BŁĄD VACUUM INTO:', err.message); process.exit(1); }
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
# Kopia, której nikt nigdy nie otworzył, to nie jest kopia zapasowa - to plik.
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
        # Świadomie NIE przerywamy skryptu: lokalna kopia jest poprawna i już
        # zweryfikowana, więc niedostępny host zapasowy nie powinien wyglądać
        # jak nieudany backup. Ale musi być głośno widoczne w logu.
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

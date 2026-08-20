#!/bin/bash
# scripts/deploy_sync.sh
#
# Safe production migration: moving from the old folder (running, holding the real .env and
# data/) to a new folder (freshly cloned from git, with the latest code), without losing the
# database, certificates or configuration.
#
# Run ON THE SERVER (after `ssh root@<vps>`, for example):
#   chmod +x scripts/deploy_sync.sh
#   ./scripts/deploy_sync.sh
#
# The script stops (set -e) at the first error, so nothing ends up half-migrated. The cutover
# (step 4) requires a [y/N] confirmation - until that point the old container keeps running,
# so the site stays online.

set -e

# --- ADJUST HERE if the folder names differ ---
OLD_DIR="/root/dietetyk-ai"
NEW_DIR="/root/Dietetyk-AI"
# --------------------------------------------------------

BACKUP_DIR="/root/backup_dietetyk_$(date +%Y%m%d_%H%M%S)"

echo "=== Sprawdzanie folderów ==="
if [ ! -d "$OLD_DIR" ]; then
  echo "BŁĄD: nie znaleziono starego folderu: $OLD_DIR"
  exit 1
fi
if [ ! -d "$NEW_DIR" ]; then
  echo "BŁĄD: nie znaleziono nowego folderu: $NEW_DIR"
  exit 1
fi
echo "OK: $OLD_DIR (stary, działający) -> $NEW_DIR (nowy, z gita)"

echo ""
echo "=== 1. Backup danych i .env ze starego folderu ==="
mkdir -p "$BACKUP_DIR"
cp -r "$OLD_DIR/data" "$BACKUP_DIR/data"
cp "$OLD_DIR/.env" "$BACKUP_DIR/.env"
echo "Backup zapisany w: $BACKUP_DIR"

echo ""
echo "=== 2. Przeniesienie .env i data/ do nowego folderu ==="
if [ -e "$NEW_DIR/.env" ] || [ -d "$NEW_DIR/data" ]; then
  echo "UWAGA: $NEW_DIR już zawiera .env lub data/ - NIE nadpisuję automatycznie."
  read -p "Nadpisać je danymi ze starego folderu? [y/N] " confirm_overwrite
  if [ "$confirm_overwrite" != "y" ] && [ "$confirm_overwrite" != "Y" ]; then
    echo "Pominięto kopiowanie .env/data. Sprawdź ręcznie przed kontynuacją."
  else
    cp "$OLD_DIR/.env" "$NEW_DIR/.env"
    cp -r "$OLD_DIR/data" "$NEW_DIR/data"
    echo "Skopiowano .env i data/ do $NEW_DIR (nadpisano)."
  fi
else
  cp "$OLD_DIR/.env" "$NEW_DIR/.env"
  cp -r "$OLD_DIR/data" "$NEW_DIR/data"
  echo "Skopiowano .env i data/ do $NEW_DIR."
fi

echo ""
echo "=== 3. Budowanie nowego folderu (stary kontener wciąż działa - brak przestoju) ==="
cd "$NEW_DIR"
docker-compose build

echo ""
echo "=== 4. Cutover: wyłączenie starego, włączenie nowego ==="
echo "Backend będzie offline przez kilka-kilkanaście sekund podczas przełączania."
read -p "Kontynuować cutover teraz? [y/N] " confirm_cutover
if [ "$confirm_cutover" != "y" ] && [ "$confirm_cutover" != "Y" ]; then
  echo "Przerwano przed cutoverem. Stary folder ($OLD_DIR) nadal działa, nic nie zmieniono."
  exit 0
fi

cd "$OLD_DIR"
docker-compose down

cd "$NEW_DIR"
docker-compose up -d

echo ""
echo "=== 5. Status i logi (Ctrl+C aby przerwać podgląd logów) ==="
docker-compose ps
echo ""
echo "Sprawdź teraz https://dietetyk.renacode.com i zaloguj się."
echo "Stary folder $OLD_DIR zostaw nietknięty kilka dni jako fallback:"
echo "  cd $OLD_DIR && docker-compose up -d   (powrót w razie problemu)"
echo ""
docker-compose logs -f dietetyk-backend

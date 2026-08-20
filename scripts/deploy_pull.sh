#!/bin/bash
# scripts/deploy_pull.sh
#
# The current deployment model: the code is built and published as Docker images by GitHub
# Actions (.github/workflows/docker-publish.yml) on every push to main. The server no longer
# builds anything from source - it only pulls ready-made
# obrazy z ghcr.io i podnosi kontenery.
#
# Requires a one-off login to ghcr.io (see the "ONE-OFF SETUP" section in the comment below)
# before you run this script for the first time, if the ghcr.io packages are private.
#
# Usage (on the server, in the directory holding docker-compose.yml):
#   chmod +x scripts/deploy_pull.sh
#   ./scripts/deploy_pull.sh

set -e

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  echo "BŁĄD: nie znaleziono ani 'docker-compose', ani wtyczki 'docker compose'."
  exit 1
fi
echo "Używam komendy: $COMPOSE"

echo ""
echo "=== 1. Szybki backup bazy danych przed aktualizacją ==="
BACKUP_DIR="/root/backup_dietetyk_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r ./data "$BACKUP_DIR/data" 2>/dev/null || echo "(brak ./data w tym katalogu - pomijam backup)"
echo "Backup: $BACKUP_DIR"

echo ""
echo "=== 2. Pobranie najnowszych obrazów z ghcr.io ==="
$COMPOSE pull dietetyk-backend dietetyk-frontend

echo ""
echo "=== 3. Restart kontenerów na nowych obrazach ==="
$COMPOSE up -d dietetyk-backend dietetyk-frontend

echo ""
echo "=== 4. Status i logi (Ctrl+C aby przerwać podgląd) ==="
$COMPOSE ps
echo ""
echo "Sprawdź https://dietetyk.renacode.com"
echo ""
$COMPOSE logs -f dietetyk-backend

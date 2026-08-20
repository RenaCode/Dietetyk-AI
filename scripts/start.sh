#!/bin/bash

# Stop the script on the first error
set -e

echo "=== Dietetyk AI: Rozpoczęcie procesu budowania i uruchomienia ==="

# Project base path (this script lives in scripts/, so go one directory up)
PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

echo "1. Budowanie Frontendu React..."
cd "$PROJECT_ROOT/frontend"
if [ ! -d "node_modules" ]; then
    echo "Instalowanie zależności frontendu..."
    npm install
fi
echo "Kompilowanie frontendu do backend/public..."
npm run build

echo "2. Instalowanie zależności Backendu..."
cd "$PROJECT_ROOT/backend"
if [ ! -d "node_modules" ]; then
    echo "Instalowanie zależności backendu..."
    npm install
fi

# Create the .env file if it does not exist
if [ ! -f ".env" ]; then
    echo "Tworzenie pliku .env z konfiguracją domyślną..."
    cp .env.example .env
    echo ">>> UTWORZONO PLIK .env. Uzupełnij GEMINI_API_KEY przed uruchomieniem!"
fi

echo "=== Gotowe! ==="
echo "Aby uruchomić aplikację lokalnie:"
echo "  cd backend && npm start"
echo ""
echo "Aby uruchomić na VPS za pomocą PM2 (w tle):"
echo "  cd backend && pm2 start server.js --name dietetyk-ai"
echo ""

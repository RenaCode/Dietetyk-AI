# Node 24 LTS (wsparcie do 04.2028) na Debianie 13 "trixie", przypięty digestem, żeby
# build był powtarzalny, a zmiana obrazu bazowego przechodziła przez review.
# Wariant trixie, a nie domyślny node:24-slim (bookworm, glibc 2.36): prekompilowana
# binarka sqlite3@6 wymaga GLIBC_2.38 - na bookwormie kończy się to ERR_DLOPEN_FAILED
# przy starcie (tak padł produkcyjny backend przy poprzedniej próbie podbicia sqlite3).
# Odświeżenie digestu: docker buildx imagetools inspect node:24-trixie-slim
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
WORKDIR /app

# Install curl for health check
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
# npm jest potrzebny tylko do instalacji zależności - kontener startuje przez
# `node server.js`. Usuwamy go z obrazu, bo jego własne node_modules (tar, undici,
# brace-expansion, ...) to jedyne podatności HIGH z ekosystemu Node w obrazie.
RUN npm ci --omit=dev \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY backend/ ./

# Uruchamiamy proces Node jako nieprivilegiowanego użytkownika "node" (wbudowany
# w obraz bazowy node:*, uid/gid 1000), a nie jako root. Ogranicza to skutki
# ewentualnej podatności w zależnościach npm - proces wewnątrz kontenera nie ma
# uprawnień roota nawet jeśli ktoś uzyska RCE.
# WAŻNE: katalog ./data montowany z hosta (wolumen /app/data) musi być na
# serwerze czytelny/zapisywalny dla uid 1000 (np. `chown -R 1000:1000 ./data`),
# inaczej backend nie będzie mógł zapisać do bazy SQLite po tej zmianie.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV DATABASE_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

# Docker (i docker-compose) sprawdza co 30s, czy backend faktycznie odpowiada
# i ma dostęp do bazy danych (GET /api/healthz - patrz backend/routes/healthcheck.js).
# Kontener oznaczony jako "unhealthy" po 3 nieudanych próbach pod rząd.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/healthz || exit 1

CMD ["node", "server.js"]

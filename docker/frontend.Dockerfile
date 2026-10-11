# Stage 1: Build the React frontend
# Obrazy bazowe przypięte digestem (odświeżenie: docker buildx imagetools inspect <obraz>).
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Serve the frontend with Nginx
# nginx-unprivileged (audit 2026-10-10, S-K1): runs as uid 101, keeps its pid and temp files in
# /tmp and listens on 8080. Same nginx line as the nginx:alpine digest it replaces (mainline
# 1.31.6, Alpine 3.24). In k3s the server block comes from charts/dietetyk (nginx-configmap.yaml,
# `listen 8080`); docker/nginx.conf below is only for the legacy docker-compose setup.
FROM nginxinc/nginx-unprivileged:alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083
COPY --from=builder /app/backend/public /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]

#!/usr/bin/env bash
#
# setup-deploy-user.sh
#
# One-off setup script for a NEW VPS (or for migrating away from an older arrangement where
# CI/CD logged in over SSH as "root").
# Run as root:
#
#   sudo bash scripts/setup-deploy-user.sh
#
# What it does:
#   1. Creates an unprivileged system user "deploy" (with no sudo rights), a member of the
#      "docker" group - enough privilege to run `docker compose pull/up/logs`, and no more.
#   2. Moves (or clones, if it does not exist yet) the repository into /opt/dietetyk-ai - the
#      same path that is hardcoded
#   3. Sets the owner of /opt/dietetyk-ai to the "deploy" user, and the data directory to
#      uid:gid 1000:1000 - the "node" user built into the node:20-slim image the backend runs
#      on (see docker/backend.Dockerfile) rather than to "deploy". Without this the backend
#      has no write access
#   4. Prepares the "deploy" user's ~/.ssh/ directory for the CI/CD key (it does not generate
#      the key itself - see "Remaining manual steps" below).
#
# Remaining MANUAL steps (the script does not perform these automatically):
#   a) Generate a NEW, dedicated SSH key pair for CI/CD only (do not reuse
#      swojego osobistego klucza):
#        ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key -N ""
#   b) Dopisz klucz PUBLICZNY (deploy_key.pub) do
#        /home/deploy/.ssh/authorized_keys
#   c) Paste the PRIVATE key (deploy_key) as the VPS_SSH_KEY secret in
#      Settings -> Secrets and variables -> Actions w repo na GitHubie.
#   d) Also set the VPS_HOST and VPS_USER=deploy secrets, plus (optionally)
#      VPS_SSH_PORT - see the comment at the top of docker-publish.yml.
#   e) Make sure /opt/dietetyk-ai contains a backend/.env file with the real production
#      secrets (APP_PASSWORD / OAUTH_STATE_SECRET, APP_URL, SMTP settings and so on) - the
#      script does not create it, because it has no business knowing your secrets.
#
# The script is idempotent - safe to run a second time (after migrating from a root-based
# setup, for instance); it will not overwrite an existing repository or account.

set -euo pipefail

APP_DIR="/opt/dietetyk-ai"
DEPLOY_USER="deploy"
REPO_URL="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "BŁĄD: ten skrypt musi być uruchomiony jako root (sudo bash $0)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "BŁĄD: Docker nie jest zainstalowany na tym serwerze. Zainstaluj Docker" >&2
  echo "i docker compose plugin przed uruchomieniem tego skryptu." >&2
  exit 1
fi

# 1. The "deploy" user (no sudo, only the "docker" group)
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "[1/4] Użytkownik '$DEPLOY_USER' już istnieje - pomijam tworzenie."
else
  echo "[1/4] Tworzenie nieprivilegiowanego użytkownika '$DEPLOY_USER'..."
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$DEPLOY_USER"
else
  echo "OSTRZEŻENIE: grupa 'docker' nie istnieje - sprawdź instalację Dockera." >&2
fi

# 2. Katalog aplikacji
echo "[2/4] Przygotowanie $APP_DIR..."
if [ -d "$APP_DIR/.git" ]; then
  echo "  $APP_DIR już jest repozytorium git - pomijam klonowanie."
elif [ -n "$REPO_URL" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
else
  mkdir -p "$APP_DIR"
  echo "  OSTRZEŻENIE: katalog $APP_DIR pusty i nie podano adresu repozytorium."
  echo "  Sklonuj je ręcznie: git clone <adres-repo> $APP_DIR"
  echo "  (Ważne: podaj ścieżkę docelową $APP_DIR explicite, inaczej git użyje"
  echo "  nazwy z GitHuba, czyli wielką literą - Dietetyk-AI - co nie zgadza"
  echo "  się ze ścieżką zaszytą w workflow CI/CD.)"
fi

# 3. Permissions: the repo directory for "deploy", the data directory for uid 1000 (node in the container)
echo "[3/4] Ustawianie właścicieli katalogów..."
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"
mkdir -p "$APP_DIR/data"
chown -R 1000:1000 "$APP_DIR/data"

# 4. The ~/.ssh directory for the CI/CD key
echo "[4/4] Przygotowanie ~/.ssh dla '$DEPLOY_USER'..."
DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
mkdir -p "$DEPLOY_HOME/.ssh"
touch "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 700 "$DEPLOY_HOME/.ssh"
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_HOME/.ssh"

cat <<EOF

Done. Account '$DEPLOY_USER' created; $APP_DIR and $APP_DIR/data have
poprawne uprawnienia.

Remaining MANUAL steps (see the full description in the comment at the top of this
skryptu):
  1. Generate a dedicated SSH key pair for CI/CD.
  2. Dopisz klucz publiczny do: $DEPLOY_HOME/.ssh/authorized_keys
  3. Klucz prywatny + adres serwera dodaj jako sekrety GitHub Actions
     (VPS_HOST, VPS_USER=deploy, VPS_SSH_KEY, opcjonalnie VPS_SSH_PORT).
  4. Place a backend/.env file with the real production secrets in $APP_DIR.
EOF

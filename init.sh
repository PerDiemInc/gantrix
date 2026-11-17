#!/usr/bin/env bash
# One-shot bootstrap: nvm -> Node (from .nvmrc) -> node_modules -> Docker infra -> running server.
# Safe to re-run; every step is skipped when already done.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

NVM_VERSION="${NVM_VERSION:-v0.40.3}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

step() { printf '\n==> %s\n' "$1"; }

# 1. nvm
step "1/5 nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found; installing $NVM_VERSION"
  curl -fsSo- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
fi
# nvm.sh is not nounset-safe
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

# 2. Node version from .nvmrc
step "2/5 Node $(cat .nvmrc)"
nvm install   # reads .nvmrc; no-op if already installed
nvm use
set -u
node -v

# 3. node_modules
step "3/5 npm install"
npm install

# 4. Docker infra (Postgres + Valkey)
step "4/5 docker compose up"
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop or OrbStack and re-run ./init.sh" >&2
  exit 1
fi
npm run setup
npm run infra:up

# 5. Migrate and run API + worker + dashboard (npm start also warns if Ollama/model is missing)
step "5/5 starting the server"
exec npm start

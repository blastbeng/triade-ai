#!/usr/bin/env bash
# Build sulla macchina potente via SSH.
#
# Le credenziali NON stanno nel repository: si leggono da variabili d'ambiente
# oppure dal file locale .build.env (ignorato da git).
#
#   BUILD_HOST=utente@host
#   BUILD_DIR=/percorso/remoto/triade-ai-build
#
# Uso: bash scripts/build-remote.sh [linux|win]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.build.env" ]; then
  # shellcheck disable=SC1091
  set -a
  . "$ROOT/.build.env"
  set +a
fi

TARGET="${1:-linux}"

: "${BUILD_HOST:?manca BUILD_HOST (es. utente@host). Definiscilo in .build.env o nell'ambiente.}"
: "${BUILD_DIR:?manca BUILD_DIR (percorso remoto). Definiscilo in .build.env o nell'ambiente.}"

echo "== sincronizzo su ${BUILD_HOST} =="
ssh "$BUILD_HOST" "mkdir -p '$BUILD_DIR'"
rsync -az --delete \
  --exclude node_modules --exclude out --exclude dist --exclude bin/stage \
  --exclude '.git' --exclude 'dati' --exclude 'models' --exclude '.build.env' \
  "$ROOT/" "$BUILD_HOST:$BUILD_DIR/"

echo "== installo dipendenze =="
ssh "$BUILD_HOST" "cd '$BUILD_DIR' && npm install --no-audit --no-fund"

if [ "$TARGET" = "win" ]; then
  echo "== binari windows + build portable exe (wine) =="
  ssh "$BUILD_HOST" "cd '$BUILD_DIR' && npm run fetch:bin -- win && npm run dist:win"
else
  echo "== binari linux + build AppImage =="
  ssh "$BUILD_HOST" "cd '$BUILD_DIR' && npm run fetch:bin -- linux && npm run dist:linux"
fi

echo "== riporto gli artefatti =="
mkdir -p "$ROOT/dist"
rsync -az "$BUILD_HOST:$BUILD_DIR/dist/" "$ROOT/dist/"
ls -lh "$ROOT/dist" | tail -5

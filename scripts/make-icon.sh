#!/usr/bin/env bash
# Rigenera build/icon.png (1024) e build/icon.ico da build/icon.svg.
# Richiede rsvg-convert (librsvg2-bin) e ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
rsvg-convert -w 1024 -h 1024 build/icon.svg -o build/icon.png
rsvg-convert -w 256 -h 256 build/icon.svg -o /tmp/icon-256.png
convert /tmp/icon-256.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico
rm -f /tmp/icon-256.png
echo "icona aggiornata: build/icon.png + build/icon.ico"

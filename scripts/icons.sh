#!/usr/bin/env bash
# Makes the toolbar/store icons (16, 32, 48, 128 px) from extension/icons/icon.svg.
# Needs ImageMagick. The PNGs are committed, so you only run this after changing the SVG.
set -euo pipefail
cd "$(dirname "$0")/../extension/icons"
for s in 16 32 48 128; do
  magick -background none -density 384 icon.svg -resize "${s}x${s}" "icon${s}.png"
done
echo "icons written to $(pwd)"

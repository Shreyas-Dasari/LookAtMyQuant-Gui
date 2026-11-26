#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/lookatmyquant-tauri"
CASK_FILE="$ROOT_DIR/Casks/lookatmyquant-gui.rb"

cd "$APP_DIR"
npm install
npm run tauri build

DMG_PATH=$(find "$APP_DIR/src-tauri/target/release/bundle/dmg" -maxdepth 1 -name "*.dmg" | head -n 1)
if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
  echo "Error: DMG not found in src-tauri/target/release/bundle/dmg" >&2
  exit 1
fi

SHA=$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')
echo "Built DMG: $DMG_PATH"
echo "SHA256:    $SHA"

if [[ -f "$CASK_FILE" ]]; then
  sed -i '' "s/sha256 \".*\"/sha256 \"$SHA\"/" "$CASK_FILE"
  echo "Updated sha256 in $CASK_FILE"
fi

#!/usr/bin/env bash
# Phone scan -> room demo on this Mac: reconstruction service + Next dev server.
# Usage (repo root): reconstruction/service/demo.sh
# Needs: Blender 4.5 (BLENDER_BIN or /Applications/Blender.app) and a Python with
# reconstruction/service/requirements.txt (PYTHON, default reconstruction/service/.venv/bin/python).
set -euo pipefail

STATE="$HOME/Library/Application Support/tadaima-reconstruction"   # outside the repo: Next watches the tree
mkdir -p "$STATE"
if [[ ! -f "$STATE/demo.env" ]]; then
  printf 'TOKEN=%s\nUPLOAD_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 8)" > "$STATE/demo.env"
  chmod 600 "$STATE/demo.env"
fi
# shellcheck disable=SC1091
source "$STATE/demo.env"

PYTHON="${PYTHON:-reconstruction/service/.venv/bin/python}"
BLENDER_BIN="${BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"
[[ -x "$PYTHON" ]] || { echo "Missing $PYTHON. Create it: uv venv reconstruction/service/.venv -p 3.12 && VIRTUAL_ENV=reconstruction/service/.venv uv pip install -r reconstruction/service/requirements.txt" >&2; exit 1; }
[[ -x "$BLENDER_BIN" ]] || { echo "Set BLENDER_BIN to Blender 4.5 LTS." >&2; exit 1; }

TADAIMA_DATA_DIR="$STATE/data" TADAIMA_API_KEY="$TOKEN" BLENDER_BIN="$BLENDER_BIN" HOST=127.0.0.1 PORT=8000 \
  "$PYTHON" -m reconstruction.service > "$STATE/service.log" 2>&1 &
SERVICE=$!
trap 'kill $SERVICE 2>/dev/null' EXIT

echo "Phone app settings:"
echo "  Tadaima server: http://$(scutil --get LocalHostName).local:3000"
echo "  Upload key:     $UPLOAD_KEY"
echo "Laptop: http://localhost:3000/rooms   (service log: $STATE/service.log)"
# No -H flag: binding 0.0.0.0 breaks dev hot reload for localhost (endless page reloads).
TADAIMA_SERVICE_URL=http://127.0.0.1:8000 TADAIMA_SERVICE_TOKEN="$TOKEN" TADAIMA_SCAN_UPLOAD_KEY="$UPLOAD_KEY" \
  npx next dev -p 3000

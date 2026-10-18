#!/usr/bin/env bash
# Phone scan -> room demo on this Mac: reconstruction service + Next dev server.
# Usage (repo root): reconstruction/service/demo.sh
# Needs: Blender 4.5 (BLENDER_BIN or /Applications/Blender.app) and a Python with
# reconstruction/service/requirements.txt (PYTHON, default reconstruction/service/.venv/bin/python).
set -euo pipefail

STATE="$HOME/Library/Application Support/tadaima-reconstruction"   # outside the repo: Next watches the tree
mkdir -p "$STATE"
if [[ ! -f "$STATE/demo.env" ]]; then
  printf 'TOKEN=%s\nUPLOAD_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 16)" > "$STATE/demo.env"
  chmod 600 "$STATE/demo.env"
fi
# shellcheck disable=SC1091
source "$STATE/demo.env"
if (( ${#UPLOAD_KEY} < 24 )); then  # the service refuses short upload keys
  UPLOAD_KEY="$(openssl rand -hex 16)"
  printf 'TOKEN=%s\nUPLOAD_KEY=%s\n' "$TOKEN" "$UPLOAD_KEY" > "$STATE/demo.env"
fi

PYTHON="${PYTHON:-reconstruction/service/.venv/bin/python}"
BLENDER_BIN="${BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"
[[ -x "$PYTHON" ]] || { echo "Missing $PYTHON. Create it: uv venv reconstruction/service/.venv -p 3.12 && VIRTUAL_ENV=reconstruction/service/.venv uv pip install -r reconstruction/service/requirements.txt" >&2; exit 1; }
[[ -x "$BLENDER_BIN" ]] || { echo "Set BLENDER_BIN to Blender 4.5 LTS." >&2; exit 1; }

# 0.0.0.0: the phone uploads straight to the service, holding only the upload key.
TADAIMA_DATA_DIR="$STATE/data" TADAIMA_API_KEY="$TOKEN" TADAIMA_UPLOAD_KEY="$UPLOAD_KEY" BLENDER_BIN="$BLENDER_BIN" HOST=0.0.0.0 PORT=8000 \
  "$PYTHON" -m reconstruction.service > "$STATE/service.log" 2>&1 &
SERVICE=$!
trap 'kill $SERVICE 2>/dev/null' EXIT

echo "Phone app settings:"
echo "  Scan server: http://$(scutil --get LocalHostName).local:8000"
echo "  Upload key:  $UPLOAD_KEY"
echo "Laptop: http://localhost:3000/rooms   (service log: $STATE/service.log)"
# No -H flag: binding 0.0.0.0 breaks dev hot reload for localhost (endless page reloads).
TADAIMA_SERVICE_URL=http://127.0.0.1:8000 TADAIMA_SERVICE_TOKEN="$TOKEN" TADAIMA_SCAN_UPLOAD_KEY="$UPLOAD_KEY" \
  npx next dev -p 3000

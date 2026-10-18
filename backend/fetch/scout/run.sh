#!/bin/sh
# Start Scout with its .env. PYTHON overrides the interpreter (default ../.venv/bin/python).
cd "$(dirname "$0")" || exit 1
set -a
. ./.env
set +a
exec "${PYTHON:-../.venv/bin/python}" -u agent.py

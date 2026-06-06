#!/bin/bash
# Vox dev server — run this in YOUR terminal so it stays up (Ctrl+C to stop).
#   cd ~/vox && ./run.sh
cd "$(dirname "$0")" || exit 1

# First run (or after moving the folder): build a fresh venv.
if [ ! -x .venv/bin/uvicorn ]; then
  echo "Setting up virtualenv…"
  rm -rf .venv
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r requirements.txt
fi

# Free the port if something's stuck on it.
lsof -ti:8000 | xargs kill -9 2>/dev/null

echo "Vox showroom → http://localhost:8000/vdp"
exec ./.venv/bin/uvicorn serve:app --port 8000

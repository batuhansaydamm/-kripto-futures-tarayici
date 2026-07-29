#!/usr/bin/env bash
set -euo pipefail

required=(BINANCE_API_KEY BINANCE_API_SECRET DASHBOARD_TOKEN)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Eksik Codespaces secret: ${name}" >&2
    exit 1
  fi
done

mkdir -p /workspaces/.v13-state
cd /workspaces/-kripto-futures-tarayici/bot-backend
exec npm start

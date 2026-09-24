#!/bin/sh

export TELEGRAM_API_ID="${TELEGRAM_API_ID:-6}"
export TELEGRAM_API_HASH="${TELEGRAM_API_HASH:-eb06d4abfb49dc3eeb1aeb98ae0f581e}"
export TELEGRAM_LOCAL="${TELEGRAM_LOCAL:-true}"

echo "[*] Delaying Telegram Bot API startup to let Python bind port 8000 first..."
(sleep 5 && echo "[*] Starting local Telegram Bot API Server..." && /docker-entrypoint.sh) &

echo "[*] Starting FetchStream Python Server..."
exec python3 server.py

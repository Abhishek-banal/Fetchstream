#!/bin/sh

# Make sure Telegram fallbacks are set if missing so the API doesn't crash on startup
export TELEGRAM_API_ID="${TELEGRAM_API_ID:-6}"
export TELEGRAM_API_HASH="${TELEGRAM_API_HASH:-eb06d4abfb49dc3eeb1aeb98ae0f581e}"
export TELEGRAM_LOCAL="${TELEGRAM_LOCAL:-true}"

echo "[*] Starting local Telegram Bot API Server..."
/docker-entrypoint.sh &

echo "[*] Waiting for Telegram Bot API to initialize..."
sleep 2

echo "[*] Starting FetchStream Python Server..."
exec python3 server.py

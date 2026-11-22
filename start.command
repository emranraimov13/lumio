#!/bin/bash
set -e
cd "$(dirname "$0")"
PORT="${PORT:-4173}"
( sleep 1; open "http://127.0.0.1:${PORT}" ) >/dev/null 2>&1 &
exec node server.js

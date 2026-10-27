#!/usr/bin/env bash
# Запуск прототипу «Орда»: ставить залежності (якщо треба) і стартує dev-сервер.
# Використання: ./start_me.sh [порт]   (за замовчуванням 5173)
set -euo pipefail

cd "$(dirname "$0")"
PORT="${1:-5173}"

if ! command -v npm >/dev/null 2>&1; then
  echo "Потрібен Node.js з npm: https://nodejs.org" >&2
  exit 1
fi

# Перевстановлюємо залежності, лише якщо їх нема або package.json новіший за node_modules.
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  echo "▶ Встановлюю залежності…"
  npm install
  touch node_modules
fi

URL="http://localhost:${PORT}/"
echo "▶ Запускаю на ${URL} (Ctrl+C — зупинити)"
exec npx vite --port "$PORT" --strictPort --open

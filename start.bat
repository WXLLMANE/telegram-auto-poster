@echo off
echo Запуск Telegram Auto Poster...
set API_ID=37080834
set API_HASH=862c5ce92c26d10f5ffeb35967e8a569
set POST_INTERVAL_MS=300000
set CONCURRENCY=30
npm run dev
pause
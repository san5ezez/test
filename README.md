# AI News Dashboard — Dashboard Edition

Эта версия предназначена для загрузки как Cloudflare Worker через Dashboard.

ВАЖНО:
- wrangler.jsonc НЕ НУЖЕН.
- package.json НЕ НУЖЕН.
- npm/CLI НЕ НУЖНЫ для настройки самого Worker.
- Bindings, Variables и Cron добавляются в Cloudflare Dashboard.

Файлы:
- src/worker.js — Worker
- public/index.html — Dashboard

Bindings:
- ASSETS — Static Assets
- DATA — KV Namespace
- AI — Workers AI

Variables/Secrets:
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
NEWS_RSS_URLS
AI_MODEL

AI_MODEL:
@cf/meta/llama-3.1-8b-instruct

Cron:
0 * * * *       — сбор данных каждый час
0 */3 * * *     — отчёт в Telegram каждые 3 часа

Google redirect URI:
https://ТВОЙ-ДОМЕН/api/gmail/callback

После подключения Gmail:
https://ТВОЙ-ДОМЕН/api/gmail/start

Telegram webhook:
https://ТВОЙ-ДОМЕН/api/telegram/webhook

Команда Telegram:
/report

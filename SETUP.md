# Настройка через Cloudflare Dashboard

1. Создай Worker/проект, который поддерживает Worker script + Static Assets.
2. Загрузь:
   - src/worker.js как Worker script
   - public/index.html как Static Assets
3. В Bindings добавь:
   DATA = KV Namespace
   AI = Workers AI
   ASSETS = Static Assets (если Dashboard просит создать asset binding)
4. В Variables and Secrets добавь переменные из README.
5. В Triggers -> Cron Triggers добавь:
   0 * * * *
   0 */3 * * *
6. Deploy.
7. Открой /api/gmail/start для OAuth Gmail.
8. Установи Telegram webhook на /api/telegram/webhook.

Если Dashboard показывает только "Static Assets" и не позволяет добавить Variables,
нужно создать именно Worker с Worker script, а не Static Assets-only приложение.

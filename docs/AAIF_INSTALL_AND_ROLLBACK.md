# Установка и откат пилота AAIF

Пилот не деплоится. Production n8n, ngrok, webhook Telegram и токены не затрагиваются.

## Проверка на машине разработчика

Нужен Node.js 22. Из корня репозитория:

```sh
node --test pilot/model-gateway/gateway.test.mjs pilot/opensandbox-poc/runner.test.mjs
node --test n8n/vk/vk-publisher.test.cjs
```

Первая команда использует мок-транспорт. Она не доказывает живой ответ Qwen или OpenRouter. Вторая команда — уже существующие локальные проверки VK; она не создаёт запись на стене.

Секреты в код не записываются. Для будущего живого вызова задаются только переменные окружения процесса: `QWEN_API_KEY`, `OPENROUTER_API_KEY`, при необходимости `QWEN_MODEL`, `QWEN_BASE_URL`, `KNIGHTCAT_OPENROUTER_MODEL`. Пример имён лежит в `pilot/model-gateway/config.example.json`.

OpenSandbox на сервер не ставится. Локальный сценарий:

```sh
node pilot/opensandbox-poc/runner.mjs
```

## Откат

Пилот находится в ветке `feature/aaif-integration-pilot`. Откат — не сливать pull request либо удалить каталоги `pilot/` и документы `docs/AAIF_*.md` и `docs/DIS_AGENT_CORE_GATEWAY_SCHEMA.md` вместе с дополнительной job в `.github/workflows/knightcat-tests.yml`.

Файлы MVP не входят в изменение поведения:

- `n8n/workflows/knightcat-minimal-telegram.json`;
- узлы `n8n/vk/nodes`;
- активный workflow n8n;
- credentials и webhook.

Их откатывать не требуется, потому что пилот их не меняет.

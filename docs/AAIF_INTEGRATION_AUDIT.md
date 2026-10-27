# Аудит KnightCat AI Studio перед пилотом AAIF

Дата проверки: 27 октября 2026. Объект — локальная копия `main` на коммите `b81a0ea`. Рабочий workflow n8n, ngrok, webhook Telegram и токены не изменялись. Этот документ описывает текущий контур и не является инструкцией по его переписыванию.

## Что реально исполняется

Оркестратор — n8n. Файл `n8n/workflows/knightcat-minimal-telegram.json` — импортируемый MVP v3. README прямо говорит, что активный сценарий в n8n этим файлом не перезаписывается. `docs/TECHNICAL_SPEC.md` v1.1 описывает целевую машину состояний и PostgreSQL; минимальный workflow хранит черновик в static data n8n. Для пилота источником истины считается исполняемый MVP, а не целевая спецификация.

## Где подключена модель

Узел HTTP Request «Generate with OpenRouter»:

- метод POST;
- URL `https://openrouter.ai/api/v1/chat/completions`;
- авторизация Header Auth, credential с именем «OpenRouter Authorization»;
- идентификатор credential в экспорте — заполнитель `REPLACE_OPENROUTER_CREDENTIAL_ID`;
- модель берётся из переменной `KNIGHTCAT_OPENROUTER_MODEL`, иначе `openai/gpt-4.1-mini`;
- таймаут 60 секунд, до трёх повторов, тело JSON, `temperature` 0.4.

В пакете контента провайдер записывается как `openrouter`. Отдельного SDK модели в репозитории нет.

## Ошибки провайдера

`n8n/vk/nodes/parse-package.js` проверяет `response.error`. При ошибке HTTP или API пакет получает `package_valid: false` и сообщение пользователю. Черновик не сохраняется и публикация не запускается. Тот же исход у невалидного JSON и у пакета, не прошедшего `vkPublisher.validateModelPackage`. Секреты в этот разбор не подставляются: ключ живёт в credential n8n.

Повтор HTTP-запроса настроен на узле, но это повтор того же вызова OpenRouter, а не отдельный шлюз моделей.

## Генерация черновика

После успешной проверки пакет со схемой `knightcat/v1.1` и статусом `review_required` кладётся в `staticData.pending[request_id]`. Пользователь получает предпросмотр в Telegram и команду `/approve REQUEST_ID`. Идентификатор собирается в `normalize.js` из chat id и message id.

## Как работает `/approve`

1. `normalize.js` распознаёт `/approve` и `/reject`, проверяет allowlist `KNIGHTCAT_ALLOWED_USER_IDS`. Пустой список никого не пропускает.
2. `load-pending.js` достаёт черновик. Если его нет, возвращает «Черновик не найден» и не публикует.
3. `vkPublisher.prepareApproval` решает, можно ли публиковать. Повторное утверждение уже опубликованного пакета блокируется.
4. Утверждение публикует текст в Telegram и, при наличии фото, готовит пост VK. `/reject` публикацию не вызывает.
5. Токены VK остаются в Bearer-credentials n8n. В репозитории только заполнители `REPLACE_VK_USER_BEARER_ID` и `REPLACE_VK_COMMUNITY_BEARER_ID`.

Утверждение — человеческий шлюз. Это не оркестратор, который можно заменить вторым агентом.

## Что можно использовать повторно

| Компонент | Повторное использование |
|---|---|
| Allowlist и типы событий в `normalize.js` | Шлюз не принимает команд публикации |
| Проверка пакета и отказ при плохом JSON | Тот же принцип fail-closed в Model Gateway |
| Переменная модели без секрета в коде | Тот же приём: имя модели и имя переменной ключа в конфиге |
| Credential n8n вместо ключа в workflow | Пилот читает ключ только из окружения процесса тестов или будущего credential |
| Smoke-кейс `no_draft_and_no_publication` | Критерий: ошибка модели не создаёт публикацию |
| Команды `/approve` и `/reject` | Остаются в n8n без изменений |

## Что пилот не переносит внутрь шлюза

Публикацию Telegram и VK, static data черновиков, allowlist и webhook. Model Gateway отвечает только за вызов модели и единый формат ответа.

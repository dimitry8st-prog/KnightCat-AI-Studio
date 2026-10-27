# Схема подключения Model Gateway после WF-04

Источник ядра: https://github.com/dimitry8st-prog/DIS-AGENT-CORE. В этом этапе его workflow не копируются и не изменяются.

## Сохраняемые свойства

| Свойство | Где остаётся |
|---|---|
| Приём события | WF-00 |
| Идемпотентность и владелец обработки | WF-01, `processed_events` |
| Авторизация и `registration_required` | WF-02 |
| Контекст и блокировки | WF-03 |
| Детерминированный маршрут | WF-04 |
| Человеческое `/approve` KnightCat | n8n MVP, без вызова из шлюза |

## Будущий вызов

```text
WF-04 route == ai_classification
        |
        v
Model Gateway.createResponse
  model: qwen | knightcat-default
  input: очищенный текст события
        |
        v
status completed + parsed_json
        или
status failed + error.code
        |
        v
существующий ответ ядра, без публикации
```

Шлюз не резервирует событие, не пишет в PostgreSQL ядра и не снимает context lock. Повтор события по-прежнему останавливает WF-01 до маршрутизатора. Ошибка модели возвращается как данные маршрута, а не как новый orchestrator.

Маршруты `payment`, `approval`, `order` и неизвестный маршрут к шлюзу не идут.

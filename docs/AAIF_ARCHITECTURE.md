# Архитектура пилота AAIF

```mermaid
flowchart LR
  TG[Telegram webhook] --> N8N[n8n MVP v3]
  N8N --> OR[Generate with OpenRouter]
  OR --> DRAFT[Черновик static data]
  DRAFT --> HUMAN[/approve или /reject]
  HUMAN --> PUB[Telegram и VK]

  subgraph pilot [Отдельный пилот, не подключён к n8n]
    GW[Model Gateway]
    QW[Адаптер Qwen]
    OA[Адаптер OpenRouter]
    SB[Локальная песочница]
    GW --> QW
    GW --> OA
  end
```

KnightCat по-прежнему вызывает OpenRouter напрямую из n8n. Model Gateway и песочница живут в `pilot/` и запускаются только тестами. Они не создают второй оркестратор и не публикуют контент.

## Подключение к DIS-AGENT-CORE после проверки

Цепочка ядра остаётся прежней:

`WF-00 Intake → WF-01 Idempotency → WF-02 User Auth → WF-03 Context → WF-04 Router → ответ`.

Будущая точка присоединения — только после WF-04, когда маршрут уже равен `ai_classification`. Шлюз получает очищенный текст и возвращает единый объект ответа. Решение о публикации остаётся за существующим человеческим утверждением KnightCat или за отдельным маршрутом `approval` ядра. Workflow `WF-00`…`WF-04` этим пилотом не изменяются.

Подробная схема: `docs/DIS_AGENT_CORE_GATEWAY_SCHEMA.md`.

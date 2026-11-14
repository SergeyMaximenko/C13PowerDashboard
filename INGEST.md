# Контракт передачі даних C# → Worker (schemaVersion 1)

Усі запити: `POST`, заголовок `X-Ingest-Secret: <INGEST_SECRET>`, `Content-Type: application/json`. Час — мілісекунди Unix (UTC).

## 1. `POST /api/ingest` (кожні ~2 хв)

```json
{
  "schemaVersion": 1,
  "snapshot": {
    "requestAt": 1760000000000, "measuredAt": 1760000000000,
    "gridStatus": 1, "gridDate": 1760000000000, "gridVoltage": 230,
    "genStatus": 0, "genDate": 1760000000000, "genPower": 0, "genVoltage": 0, "genPeak": 0,
    "inverterStatus": 1, "inverterDate": 1760000000000, "loadWatts": 850,
    "soc": 87, "batteryMode": "charging", "batteryWatts": -400,
    "indicatorsHtml": "<b>Показники станом на:</b>\n…", "indicatorsAt": 1760000000000
  },
  "journalHash": "abc123", "refuelsHash": "def456"
}
```

`batteryMode`: `charging` | `discharging` | `idle`. Статуси: `1` / `0` / `null`.
`indicatorsHtml` — показники генератора (той самий текст у форматі Telegram, що C# пише в нотатку закладки «Показники»), `indicatorsAt` — час, на який вони пораховані. Якщо цього разу показників немає (`null`), Worker лишає попередні. Worker сам очищає HTML (дозволені `b`, `i`, `u`, `blockquote` і посилання `https://t.me/…`) і ділить на секції за порожніми рядками; перший блок «Показники станом на» відкидається. Показники віддаються лише у звіті генератора (за паролем), `/api/status` їх не містить.
Відповідь: `{ "ok": true, "needJournal": false, "needRefuels": true }`.
Worker пише знімок у KV одним ключем (разом із показниками, один запис на запуск) не на кожному запуску (ліміт KV — 1000 записів/добу): одразу, якщо змінився статус (`gridStatus`, `genStatus`, `inverterStatus`); якщо змінився лише `measuredAt` — не частіше ніж раз на 110 секунд після попереднього запису. Решта полів (заряд, потужності, показники) потрапляють у KV разом із найближчим записом, тож на сторінці вони можуть відставати до ~2 хвилин. Найгірший випадок — 785 записів знімка на добу, навіть якщо C# надсилає частіше.

## 2. `POST /api/ingest/journal` (лише коли `needJournal`)

```json
{ "schemaVersion": 1, "hash": "abc123",
  "rows": [ { "object": "Світло", "at": 1760000000000, "onOff": 0, "hoursPowerOff": null, "hoursGenOn": null, "peakW": null, "test": false } ] }
```

`object`: `Світло` | `Генератор`. Рядки з `test: true` (Режим тесту = «так») у звіті ігноруються.

## 3. `POST /api/ingest/refuels` (лише коли `needRefuels`)

```json
{ "schemaVersion": 1, "hash": "def456", "rows": [ { "at": 1760000000000, "liters": 20, "by": "Ім'я" } ] }
```

Хеш обчислює C# від вмісту блоку; Worker зберігає його разом з блоком і порівнює з `journalHash`/`refuelsHash` зі знімка.
Помилки: `401` (секрет), `400` (формат), `409` (непідтримувана `schemaVersion`).

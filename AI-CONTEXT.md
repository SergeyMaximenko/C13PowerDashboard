# AI-CONTEXT — вступ для нового чату

Секретів у файлі немає. Користувач пише українською/російською, пояснення давати українською, коротко, кроками; перед змінами любить бачити пропозицію.

## Проєкт

- `C13PowerDashboard` — дашборд «Чавдар 13» (мережа, інвертор, батарея, генератор) і закладки «Паливо та ТО» та «Генератор» (одна сторінка `public/index.html`, три закладки; код закладок — `public/generator.js`). Стек: статична сторінка на ванільному JS (`public/`) + Cloudflare Worker (`worker/index.mjs`, `lib/*.mjs`). Без npm-залежностей.
- Дані надсилає C#-застосунок `ScheduleDisconnectLight` (`C:\Users\maximenko\Documents\GitHub\ScheduleDisconnectLight`, GitHub Actions ~кожні 2 хв): він читає Deye, пише Google Sheet (`DeyeСтатус`, `DeyeСтатистика`, `ЗаправкаСтатистика`) і шле на Worker (`Service/WorkerSync.cs`). Worker до Deye не звертається. Контракт: `INGEST.md` (schemaVersion 1).
- Worker `c13-power` (`https://c13-power.sergeymaximenko.workers.dev`), KV `DATA` (namespace `C13PowerDashboard`). Репозиторій `SergeyMaximenko/C13PowerDashboard` (гілка `main`), сторінка `https://sergeymaximenko.github.io/C13PowerDashboard/`.

## Команди

```
npm test              # усі тести (Node >= 22)
npm run build         # dist/ для GitHub Pages
npx wrangler dev      # локальний Worker (.dev.vars)
npx wrangler deploy   # опублікувати Worker
npx wrangler secret put INGEST_SECRET   # також REPORT_PASSWORD
```

Послідовність: правка → `npm test` → (якщо чіпали `worker/`, `lib/`, `wrangler.toml`) `wrangler deploy` → commit + push.

## Де що

- `lib/indicators.mjs` — очищення HTML показників генератора (текст з нотатки «Показники», C# передає його у знімку) і розбиття на секції для сторінки звіту.
- `lib/ingest.mjs` — очищення (allowlist) даних від C#, знімок → статус дашборда. `lib/journal-sessions.mjs` — сеанси генератора з журналу. `lib/domain.mjs` — правила станів (дублюються в C# `PowerCalc`). `lib/public-status.mjs` — allowlist відповіді `/api/status`.
- Звіт генератора за паролем (`REPORT_PASSWORD`, заголовок `X-Report-Password`); `/api/status` відкритий. Імена людей і ніки лише за паролем.
- Синхронізація за хешем: знімок щоразу, журнал/заправки повністю лише коли хеш Worker відрізняється від хешу C#.

## Правила змін

1. Не віддавати браузеру нічого поза allowlist; секрети й токени не логувати й не писати в репозиторій.
2. Не зберігати у Worker між запитами `Promise`; лише прості дані. KV на безкоштовному плані: 1000 записів/добу.
3. Тести завантажують шматки `public/app.js` за маркерами функцій (`function inverterState(`, `function measurementDateLabel(`, `function render(`, `async function api(`, `async function refresh(`) у `vm`: не ламати маркери.
4. SVG: `hidden` перемикати через `setHidden`; Safari погано переносить `var()` у `@keyframes`.
5. Перед завершенням — `npm test`.

## Відкрито


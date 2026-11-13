# AI-CONTEXT — вступ для нового чату

Скопіюйте цей файл (разом із `TECHNICAL.md`, якщо потрібні подробиці) на початок нової розмови з AI. Секретів у файлі немає.

## Проєкт у 10 рядках

- Дашборд «Чавдар 13»: мережа на вході інвертора, робота інвертора (схема АВР: пріоритет у мережі), заряд/режим батареї, приблизний час появи/зникнення мережі.
- Стек: статична сторінка на ванільному JS (`public/`) + Cloudflare Worker (`worker/index.mjs`, `lib/*.mjs`) + Deye Cloud API (EU). Без npm-залежностей і збирача (крім `npm run build`, який лише копіює файли й додає `?v=hash`).
- Потік: Deye Cloud → Worker `c13-power` (`/api/status`, кеш 30 с) → сторінка на GitHub Pages.
- Адреси: сторінка `https://sergeymaximenko.github.io/C13PowerDashboard/`, Worker `https://c13-power.sergeymaximenko.workers.dev`.
- Репозиторій: `SergeyMaximenko/C13PowerDashboard`, гілка `main`. Локально: `C:\Users\maximenko\Documents\GitHub\C13PowerDashboard` (Windows, GitHub Desktop, VS Code + Live Server).
- Користувач пише українською/російською, пояснення давати українською, коротко, кроками.

## Команди

```
npm test                 # усі тести (Node ≥ 22)
npm run build            # dist/ для GitHub Pages
npx wrangler dev         # локальний Worker (потрібен .dev.vars)
npx wrangler deploy      # опублікувати Worker
npx wrangler deployments list
npx wrangler secret put DEYE_APP_ID   # також DEYE_APP_SECRET, DEYE_LOGIN, DEYE_PASSWORD
```

Послідовність змін: правка → `npm test` → (якщо змінювались `worker/`, `lib/`, `wrangler.toml`) `npx wrangler deploy` → commit + push (Actions сам публікує сторінку). Push Worker не оновлює.

## Де що лежить

- Секрети Deye — лише Cloudflare Worker secrets (+ локальний `.dev.vars`, у `.gitignore`). У репозиторії їх немає і додавати не можна.
- Не секретні налаштування — `wrangler.toml`: `DEYE_STATION_ID`, `DEYE_STATION_NAME`, `CACHE_SECONDS=120`, `ALLOWED_STATION_IDS` (`?station=ID`).
- Бізнес-логіка: `lib/domain.mjs` (мережа 180–260 В/45–55 Гц; стара ≥ 1 год; поріг батареї 70 Вт) і `inverterState()` у `public/app.js`.
- Робота генератора за період: `GET /api/generator?from=&to=` (`lib/generator.mjs`; історія Deye по днях, підсумки завершених днів у KV `GEN`, ключ `gen:v2:…`; у `measurePoints` не більше 4 ключів). Основна сторінка його не викликає. Деталі — `TECHNICAL.md` 6.6.
- Звіт про генератор захищений паролем (секрет Cloudflare `REPORT_PASSWORD`, заголовок `X-Report-Password`, пароль запам'ятовується в `localStorage` сторінки; `/api/status` відкритий). Не вписувати пароль у код чи репозиторій.
- Звіт про генератор: `GET /api/generator-report` — дні, позначки заправок із Google Sheet (CSV, секрет `REFUELS_CSV_URL`) і «відпрацював з останньої заправки». Окрема сторінка `public/generator.html` (+ `generator.js`, `generator-lib.js`, `generator.css`; `index.html` не чіпає): `https://sergeymaximenko.github.io/C13PowerDashboard/generator.html`. Збірка (`tools/build-pages.mjs`) версіонує її файли окремо. З основної сторінки сюди веде посилання «Деталі по генератору →» у плитці «Генератор».
- Публікація сторінки: `.github/workflows/pages.yml` (push у main → тести → build → Pages).

## Обов’язкові правила для змін

1. Не зберігати між запитами у Worker `Promise` (завішує запити); лише прості дані.
2. Не віддавати браузеру нічого поза allowlist `lib/public-status.mjs`; секрети й токени ніколи не логувати.
3. Тести завантажують шматки `public/app.js` за маркерами функцій (`function inverterState(`, `function measurementDateLabel(`, `function render(`, `async function api(`, `async function refresh(`) у `vm` з примітивним DOM (без `style`, `classList`, `toggleAttribute`): не ламати маркери, використовувати `style?.`.
4. SVG: `hidden` перемикати через `setHidden`; стилі всередині `<use>` без батьківських селекторів; Safari/iPhone погано переносить `var()` у `@keyframes` і анімований SVG-`<text>`.
5. Перед завершенням змін — `npm test`; нагадати про `wrangler deploy`, якщо чіпали Worker або `lib/`.
6. Усі три іконки карток мають однаковий розмір рамки (104/88/68 px за брейкпоінтами).

## Стан і відкриті питання (на дату створення)

- Worker: CPU P90 ≈ 24 мс (запити без кешу), помилок 0, ~1,2 тис. викликів/добу — на безкоштовному плані.
- Не зроблено: вимкнути зовнішній cron, відкликати старий класичний токен GitHub, видалити Worker `c13-test`, прибрати застарілі `DEYE_*` у налаштуваннях репозиторію.
- Квота Deye 100 000 викликів/міс: зроблено кеш списку інверторів (24 год), `CACHE_SECONDS=120` і Cache API (`X-Cache: EDGE`). Результат перевірити за «Calls (24h)» у Deye (ціль ≲ 1 500/добу).
- Ідеї без потреби зараз: пауза після помилки Deye, сторінка «Генератор» на базі `/api/generator`, підтягування попереднього дня для склейки нічного сеансу при запиті за один день.

Повні подробиці — `TECHNICAL.md`.

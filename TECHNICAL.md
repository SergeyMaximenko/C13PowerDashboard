# C13PowerDashboard — технічна документація

Опис для розробника або AI-асистента, який бачить проєкт уперше. Користувацький огляд — `README.md`, короткий вступ для нового чату — `AI-CONTEXT.md`, формат даних від C# — `INGEST.md`. Секретів у файлі немає.

## 1. Що це і як влаштовано

Дашборд «Чавдар 13» показує: чи є мережа на вході інвертора, чи працює інвертор (схема з АВР, пріоритет у мережі), заряд і режим батареї, стан генератора, приблизний час появи/зникнення мережі. Окрема сторінка — звіт про роботу генератора й заправки.

```
Deye Cloud → ScheduleDisconnectLight (C#, GitHub Actions ~кожні 2 хв)
              ├─ Google Sheet: DeyeСтатус (поточний стан), DeyeСтатистика (журнал), ЗаправкаСтатистика
              └─ POST /api/ingest* → Cloudflare Worker `c13-power` (KV `DATA`) → сторінка (GitHub Pages)
```

- Worker не звертається до Deye і не має його секретів. Єдине джерело даних — C#-застосунок.
- Сторінка — чистий HTML/CSS/JS без залежностей: `public/`.
- Адреси: Worker `https://c13-power.sergeymaximenko.workers.dev`, репозиторій `SergeyMaximenko/C13PowerDashboard` (гілка `main`), сторінка `https://sergeymaximenko.github.io/C13PowerDashboard/`, локально `C:\Users\maximenko\Documents\GitHub\C13PowerDashboard`.
- Автооновлення сторінки немає: дані беруться при відкритті, кнопці «Оновити» (cooldown 10 с) і поверненні у вкладку, якщо минула > 60 с.

## 2. Структура файлів

| Шлях | Призначення |
|---|---|
| `public/index.html`, `app.js`, `styles.css` | Одна сторінка: розмітка, SVG-іконки, закладки, картки «Стан», логіка, анімації, стилі всіх закладок. `<meta name="dashboard-api">` — адреса Worker. |
| `public/generator.js`, `generator-lib.js` | Закладки «Паливо та ТО» та «Генератор»: ледаче завантаження звіту, періоди 1/7/14/30 днів, пароль, секції показників. `generator-lib.js` — чисті функції. Окремої сторінки немає. |
| `worker/index.mjs` | Маршрути, ingest, звіт генератора, CORS, пароль звіту. |
| `lib/ingest.mjs` | Очищення (allowlist) даних від C#, знімок → статус дашборда. |
| `lib/journal-sessions.mjs` | Сеанси генератора з журналу, підсумок дня. |
| `lib/indicators.mjs` | Очищення HTML показників генератора (allowlist тегів і посилань t.me) і розбиття на секції. |
| `lib/domain.mjs` | Правила станів і утиліти часу (дублюються в C# `PowerCalc`). |
| `lib/generator.mjs` | Склейка сеансів через північ, обрізання за моментом заправки, локальний час. |
| `lib/public-status.mjs` | Allowlist полів, які віддаються браузеру. |
| `tools/build-pages.mjs` | `npm run build`: копіює `public/` у `dist/`, додає `?v=<hash>` до `app.js`, `styles.css`, `generator.js` і до імпорту `generator-lib.js`. |
| `tests/*.test.mjs` | Тести Node (`node --test`). |
| `wrangler.toml`, `.dev.vars.example` | Конфігурація Worker і шаблон локальних секретів. |
| `.github/workflows/pages.yml` | Публікація сторінки на GitHub Pages. |

`dist/`, `.dev.vars`, `.wrangler/`, `node_modules/` — у `.gitignore`.

## 3. Команди (з папки проєкту)

| Дія | Команда |
|---|---|
| Тести | `npm test` (Node ≥ 22) |
| Збірка сторінки | `npm run build` (результат у `dist/`) |
| Локальний Worker | `npx wrangler dev` (`http://127.0.0.1:8787/api/status`) |
| Публікація Worker | `npx wrangler deploy` |
| Історія версій | `npx wrangler deployments list` |
| Секрет | `npx wrangler secret put INGEST_SECRET` (також `REPORT_PASSWORD`) |
| Список секретів | `npx wrangler secret list` |

Послідовність змін: правка → `npm test` → якщо чіпали `worker/`, `lib/` або `wrangler.toml`, то `npx wrangler deploy` (push Worker не оновлює) → commit + push (Actions публікує сторінку за 1–2 хв) → Ctrl+F5; на iPhone нова вкладка. Правки лише в `public/` не потребують `wrangler deploy`.

## 4. Локальна розробка

- Сторінка: VS Code → `public/index.html` → Live Server. `?api=http://127.0.0.1:8787` бере дані з локального Worker (дозволені лише `localhost`/`127.0.0.1`).
- Внизу сторінки перемикач «Перегляд» з прикладами (мережі немає, режим очікування, дані застаріли, завантаження тощо).
- Локальні секрети: `.dev.vars` (шаблон `.dev.vars.example`): `INGEST_SECRET`, `REPORT_PASSWORD`. Без `INGEST_SECRET` ingest повертає 500.
- `wrangler dev` використовує локальне KV; щоб побачити дані, надішліть знімок через `POST /api/ingest` (див. `INGEST.md`) або запустіть C# з `WORKER_URL=http://127.0.0.1:8787`.

## 5. Секрети й конфігурація

| Що | Де |
|---|---|
| `INGEST_SECRET` | Cloudflare Worker secret; той самий у C# (`appsettings.Local.json` локально, GitHub Secret `INGEST_SECRET`). |
| `WORKER_URL` | C#: `appsettings.Local.json` / GitHub Secret `WORKER_URL`. |
| `REPORT_PASSWORD` | Cloudflare Worker secret (пароль звіту генератора, необов'язковий). |
| `ALLOWED_ORIGIN` | `wrangler.toml` `[vars]` (закоментовано): якщо задати, CORS обмежується цією адресою; зараз `*`. |
| KV `DATA` | `wrangler.toml` `[[kv_namespaces]]`, namespace `C13PowerDashboard`. |

Секрети Deye (`DEYE_*`) є лише в C#-проєкті (GitHub Secrets / `appsettings.Local.json`), у цьому проєкті їх немає.

## 6. Worker (`worker/index.mjs`)

### 6.1. Маршрути

| Маршрут | Дія |
|---|---|
| `GET /`, `GET /health` | `{"ok":true}` |
| `POST /api/ingest` | знімок + `journalHash`/`refuelsHash` → `{ ok, needJournal, needRefuels }` |
| `POST /api/ingest/journal` | повний журнал `{ schemaVersion, hash, rows }` |
| `POST /api/ingest/refuels` | повні заправки `{ schemaVersion, hash, rows }` |
| `GET /api/status` | стан дашборда зі знімка; 503, якщо даних ще не було |
| `GET /api/generator-report`, `GET /api/generator` | звіт генератора (однакова відповідь), `?from=&to=`, ≤ 31 дня, `to` не в майбутньому; за паролем |
| `OPTIONS` | `204` з CORS (`GET, POST, OPTIONS`; заголовки `X-Report-Password`, `X-Ingest-Secret`, `Content-Type`) |

Відповіді: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.

### 6.2. Ingest і KV

- Усі POST потребують `X-Ingest-Secret` (порівняння без раннього виходу); 20 невдалих спроб з адреси → 429. Тіло ≤ 2 МБ, `schemaVersion` має бути 1 (інакше 409). Усі поля проходять allowlist і перевірку типів (`lib/ingest.mjs`).
- Ключі KV: `ingest:snapshot` (`{ snapshot, receivedAt }`), `ingest:journal` (`{ hash, rows, receivedAt }`), `ingest:refuels` (так само).
- Показники генератора (`indicatorsHtml` + `indicatorsAt`) їдуть усередині знімка й зберігаються в тому ж ключі `ingest:snapshot` як `snapshot.indicators = { at, sections[{title,html}] }`: один запис KV на запуск. Якщо запуск показників не надіслав, лишаються попередні. HTML очищається на Worker (`lib/indicators.mjs`), сторінка вставляє його через `innerHTML`.
- Знімок пишеться за правилом `shouldWriteSnapshot` (`lib/ingest.mjs`): (1) у KV ще нічого немає або запис непридатний; (2) змінився один зі статусів (`gridStatus`, `genStatus`, `inverterStatus`) — пишемо одразу; (3) змінився `measuredAt`, і від попереднього запису минуло щонайменше `SNAPSHOT_MIN_GAP_MS` = 110 с. Інакше запису немає. Причина: KV на безкоштовному плані дозволяє 1000 записів/добу; найгірший випадок 86400/110 = 785 записів знімка на добу незалежно від частоти запусків C#. Поріг трохи менший за 2 хв навмисно: запуски йдуть приблизно раз на 2 хв із розкидом, і рівно 2 хв пропускали б кожен другий запуск. Час у майбутньому або зламаний `receivedAt` запис не блокує. Побічний ефект: решта полів (заряд, потужності, показники) відстає до ~2 хв, але статуси — ні.
- Журнал і заправки C# надсилає повністю лише коли хеш Worker відрізняється від його хешу (`needJournal`/`needRefuels`). Ручні правки таблиці потрапляють на Worker самі. Хеш Worker зберігає такий, як надіслав клієнт.
- Між запитами в Worker зберігаються лише прості дані (лічильники спроб). Ніколи не зберігати `Promise` іншого запиту.

### 6.3. `/api/status`

`snapshotToStatus()` перетворює знімок на формат дашборда; `publicStatus()` пропускає лише дозволені поля. Мережа/вихід: статус `1` → `on`, `0` → `off`, інакше `unknown`. `allPhasesZero` = напруга мережі 0. Події `events.appeared/disappeared` виводяться з `gridStatus` + `gridDate`. Дані старші за 30 хв (`STALE_MS`) → `stale: true`.

### 6.4. Звіт генератора

- Сеанси: `sessionsFromJournal()` бере рядки «Генератор» (без `test`): `onOff = 1` — запуск, `0` — зупинка. Якщо запуск без зупинки і `genStatus` у знімку не `0` — сеанс триває (`open: true`). Якщо рядка запуску немає, а в рядку зупинки є `hoursGenOn`, початок вираховується з нього.
- День: хвилини сеансів у межах календарного дня (Київ), `starts` — запуски цього дня, `peakW` — максимум за сеанси дня. Сеанс через північ у `sessions` склеюється; у `days[]` хвилини по календарних днях. Дні до першого запису журналу — `missingDays: no-data`.
- Потужність: `peakW` береться з рядка зупинки (колонка G журналу), для сеансу, що триває, — зі знімка (`genPeak`).
- Заправки: блок `ingest:refuels` (рядки `{ at, liters, by }`; тестові й «Не враховувати» C# не передає) показуються мітками в день заправки. Підсумки «після останньої заправки», паливо й ТО Worker не рахує: це робить C# і передає готовим текстом показників.
- Відповідь: `{ from, to, timezone, totalMinutes, totalStarts, days[{date,minutes,starts,peakW,refuels}], sessions[{start,end,minutes,peakW,open,startLocal,endLocal}], indicators, refuels, refuelsConfigured, refuelsError, missingDays }`.
- Закладки сторінки: «Стан» (завантажується одразу через `/api/status`), «Паливо та ТО» (секції показників, час «Пораховано … N хв тому», жовтий, якщо старіше 30 хв; «Запланові відключення» згорнуті) і «Генератор» (кнопки 1/7/14/30 днів, поля «З/По», підсумок, дні з сеансами й мітками заправок; при одному дні сеанси розгорнуті). Обидві закладки живляться одним запитом `/api/generator-report`, який робиться при першому відкритті закладки й повторюється, якщо дані старші за хвилину; кнопка «Оновити» оновлює відкриту закладку. Закладка запам'ятовується в адресі (`#fuel`, `#generator`). Стилі всіх закладок — у `styles.css`.
- Пароль: секрет `REPORT_PASSWORD`; сторінка надсилає його в `X-Report-Password` (URL-кодований), запам'ятовує в `localStorage` після успіху, забуває при 401. Без секрету звіт відкритий. 10 невдалих спроб за 10 хв з адреси → 429. `/api/status` пароля не вимагає. Імена тих, хто заправляв, віддаються лише за паролем.

### 6.5. Обмеження Cloudflare (безкоштовний план)

100 тис. запитів/добу, ~10 мс CPU на виклик, 50 підзапитів; KV: 1000 записів/добу, 100 тис. читань/добу. Звіт читає 3 ключі KV за запит.

## 7. Бізнес-логіка

Правила обчислюються в C# (`ScheduleDisconnectLight/Service/PowerCalc.cs`) і дублюються в `lib/domain.mjs` для сторінки/тестів. Змінюючи пороги, змінювати в обох місцях.

### 7.1. Мережа на вході

`on` — 180–260 В на всіх очікуваних фазах і 45–55 Гц; `off` — напруга < 50 В і частота < 1 Гц; `unstable` — повні вимірювання, але поза діапазонами (у C# статус при цьому не міняється); `unknown` — неповні дані. Дані старші за 30 хв (`STALE_MS`; у `public/app.js` дзеркальна `STALE_AFTER_MS`, міняти разом) — усе «невідомо». Позначка «Пройшло …» жовта після 15 хв (`WARN_AFTER_MS`).

### 7.2. Батарея

`soc` — з вимірювання інвертора. Режим за потужністю батареї: > 70 Вт `discharging`, < −70 Вт `charging`, інакше `idle`. Якщо мережа `on`, а розряд менший за 150 Вт (`MAINS_IDLE_LIMIT`), режим `idle` (власне споживання інвертора). На плитці при заряді ≥ 99% «Повністю заряджена».

### 7.3. Стан інвертора (`inverterState` у `public/app.js`)

Схема з АВР: за наявності мережі будинок підключено до неї.
- Мережа `on`: `charging` → «Інвертор заряджає акумулятор»; вихід `off` → «Немає напруги на виході»; `idle`/`discharging` → «Інвертор у режимі очікування»; інакше `unknown`.
- Мережа `off`: вихід `on` і навантаження > 0 → `supplying` («від батареї», а при працюючому генераторі «від генератора»); вихід `off` і є навантаження → `unknown`; навантаження 0 і зарядка → `charging`; вихід `off` → `off`; навантаження 0 і `idle`/`discharging` → `standby`; інакше `unknown`.

### 7.4. Генератор (вхід GEN інвертора)

Працює: напруга GEN ≥ 150 В або потужність ≥ 800 Вт. Якщо напруга є, потужність < 800 Вт, а батарея ще розряджається — `starting` («Готується до роботи»: двигун працює, інвертор ще не взяв генератор). `off` — значення є, але напруги й потужності немає; `unknown` — параметрів немає або дані застаріли. Знімок передає `genStatus` (1/0), `genPower`, `genVoltage`, `genPeak`; стан `starting` на сторінці виводиться з `genStatus` і режиму батареї. Журнал змін генератора (запуск/зупинка) веде C#.

### 7.5. Час «з'явилася / зникла»

Береться з дати статусу мережі (`gridDate`, час вимірювання Deye, коли статус змінився). Якщо дати немає — рядок прихований.

## 8. Фронтенд

### 8.1. Потік даних (`public/app.js`)

`api()` формує URL (`?api=` лише localhost, інакше `<meta name="dashboard-api">`), `fetch` з `cache: 'no-store'` і таймаутом 45 с. `refresh()`: скелетон (`setLoading`), до 3 повторів по 10 с, ігнорує відповіді зі старішим `collectedAt`, `requestVersion` проти гонок. `render(data, example)` оновлює картки. Таймери: 1 с — «Пройшло …», 15 с — повторний рендер для застарівання.

### 8.2. Анімації

Мережа (`#grid-anim`): опора з проводами і пунктир-струм при `on`. Інвертор (`#inverter-anim`): дві шестерні, що обертаються, при `supplying`/`charging`. Батарея: заряд — щасливий, іскри; розряд — сонний, літери Z (контури `<path>`). Генератор: димок і блискавка. `prefers-reduced-motion` вимикає анімації.

### 8.3. Пастки

- Стилі всередині `<use>`: селектори `.parent .child` не діють у shadow-дереві; використовувати прості класи.
- `hidden` на SVG перемикати через `setHidden(el, on)`.
- Глобальне `svg { fill:none; stroke:currentColor }` вимагає явних `fill`/`stroke`.
- Safari/iPhone: змінні CSS у `@keyframes` зависають (тому окремі `m-level-up`/`m-level-down`), SVG-`<text>` з трансформаціями нестабільний, не додавати ручний перезапуск анімацій.
- Скелетон не накладати на анімовані сцени (`:not(.mascot):not(.ivscene):not(.gridscene)`).
- Усі три плитки мають однакову рамку іконки: 104 px на ПК, 88 px до 760 px, 68 px до 350 px.

### 8.4. Тести і порізка `app.js`

Тести завантажують шматки `public/app.js` за маркерами (`function inverterState(` … `function measurementDateLabel(`; `function render(` … `async function api(`; `async function refresh(`) у `vm` з примітивним DOM (без `style`, `classList`, `toggleAttribute`). Не переставляти маркери; нові допоміжні функції для `render` класти між `render` і `async function api(`; до `style` звертатися як `style?.setProperty`.

## 9. Тести (`tests/`)

| Файл | Що перевіряє |
|---|---|
| `indicators.test.mjs` | Очищення HTML (allowlist, посилання t.me, екранування), секції, показники в знімку, не віддаються в `/api/status`. |
| `ingest.test.mjs` | Секрет, `schemaVersion`, хеші (`needJournal`/`needRefuels`), запис у KV лише при зміні, `/api/status`, звіт генератора (сеанси, північ, тестовий рядок, потужність, мітки заправок). |
| `worker.test.mjs` | Статус зі знімка, `stale`, 503 без даних, методи, CORS. |
| `auth.test.mjs` | Пароль звіту: 401/429, кодування, відкритий режим, відсутність пароля у відповідях. |
| `domain.test.mjs`, `operation.test.mjs`, `age.test.mjs` | Стани мережі/батареї/інвертора, часові пояси, підписи віку. |
| `generator.test.mjs`, `refuels.test.mjs` | Склейка й обрізання сеансів, розбір CSV та час заправки. |
| `generator-page.test.mjs`, `pages.test.mjs` | Сторінка звіту, збірка `dist/`, адреса Worker, `?api` лише для localhost. |

## 10. Публікація сторінки

`.github/workflows/pages.yml`: `push` у `main` і ручний запуск → checkout → Node 22 → `npm test` → `npm run build` → upload `dist` → deploy-pages. Секрети не потрібні. Якщо тести падають, публікації немає. `?v=<hash>` у посиланнях змушує браузери підтягнути нову версію.

## 11. Типові проблеми

| Симптом | Причина / дія |
|---|---|
| `/api/status` → 503 «Дані ще не надходили» | C# ще не надсилав знімок: перевірити `WORKER_URL`/`INGEST_SECRET` і лог `WorkerSync`. |
| З Visual Studio нічого не доходить на сайт | Так задумано: у тестовому режимі (локальний запуск) `WorkerSync` нічого не передає, щоб тестові дані не потрапили на сайт (рядок «тестовий режим, передачу на сайт пропущено»). Свідомо перевірити локально: змінна середовища `WORKER_SYNC_FORCE=1`. |
| Ingest → 401 | Не збігається `INGEST_SECRET` у Worker і C#. |
| Ingest → 500 | Немає секрету `INGEST_SECRET` або KV-прив'язки `DATA`. |
| Звіт → 503 «Журнал ще не надходив» | Спочатку має відбутися `needJournal` → `POST /api/ingest/journal`; запустити C# ще раз. |
| Усе «Невідомо» / `stale` | Знімок старший за 30 хв: C# не запускається або Deye не віддає нові дані. |
| Після push старий вигляд | Ще йде Actions або кеш браузера: Ctrl+F5, на iPhone нова вкладка. |
| Worker поводиться по-старому | Забули `npx wrangler deploy`. |
| Сеанс 0 хв у звіті | У журналі час зупинки майже збігається із запуском: виправити дату рядка. |
| Анімація зависає на iPhone | Розділ 8.3. |

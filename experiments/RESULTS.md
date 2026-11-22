# MCP Tasks, ноябрь 2026: что проверено руками

Сводка всех прогонов. Данные на 20–22 ноября 2026. Песочница: Windows 11, Node.js 24.20.0,
`@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `zod` 4.6.7;
для языковых прогонов — Go 1.27.4, .NET SDK 10.0.404, Rust 1.100.0 (MinGW, GNU target),
Temurin JDK 21.0.13.1 и Maven 3.10.2.
Скрипты лежат в этой папке, логи и JSON-результаты — рядом с ними. Как запускать — в `README.md`,
карта «утверждение → файл» — в `../ARTIFACTS.md`.

## 1. Эксперимент 0: 13 HTTP-зондов

Сервер: `exp0_probe/server.mjs`, прогон: `exp0_probe/probe.mjs`.
Минимальный сервер на TS SDK v2 без расширения Tasks.

| № | Запрос | HTTP | Код | Что означает |
|---|--------|------|-----|--------------|
| 1 | `server/discover` + Tasks в clientCapabilities | 200 | — | `supportedVersions: ["2026-07-28"]`, `capabilities.tools`, `ttlMs: 0`, `cacheScope: "private"`, расширений нет |
| 2 | `tools/call` с верными `Mcp-Method`/`Mcp-Name` | 200 | — | `resultType: "complete"` |
| 3 | `Mcp-Name: foo`, в теле `name: echo` | 400 | -32020 | есть `data.mismatch` с header/body |
| 4 | `Mcp-Method: tools/list`, метод `tools/call` | 400 | -32020 | то же |
| 5 | версия `1900-01-01` в заголовке и `_meta` | 400 | -32022 | `data: {supported: ["2026-07-28"], requested: "1900-01-01"}` |
| 6 | legacy `initialize` 2025-11-25 | 200 | — | SSE-ответ, `protocolVersion: "2025-11-25"` |
| 6b | legacy `tools/call` после initialize | 200 | — | stateless-fallback обслуживает и следующий запрос |
| 7 | `tasks/get` на сервере без Tasks | 404 | -32601 | Method not found |
| 8 | нет `Mcp-Method` | 400 | -32020 | «required Mcp-Method header is absent» |
| 9 | нет `Mcp-Name` на `tools/call` | 400 | -32020 | «required Mcp-Name header is absent» |
| 10 | заголовок 2026-07-28, `_meta` 2025-11-25 | 400 | -32020 | версия сверяется и между заголовком и телом |
| 11 | `tasks/list` | 404 | -32601 | метода нет |
| 12 | инструмент с задержкой 1 с | 200 | — | ответ за 1,1 с, `resultType: "complete"` |

Выводы:

- Ядро 2026-07-28 в TS SDK v2 работает, включая валидацию зеркалированных заголовков.
- Отсутствие обязательного заголовка — это тот же `-32020`, что и расхождение. Удобный smoke-тест
  для чужого сервера: если он отвечает 200 на `Mcp-Name: foo` при `name: echo`, он не валидирует
  зеркалирование.
- `tasks/get` на сервере без Tasks даёт 404/-32601. Клиент обязан уметь откатиться на обычный вызов.
- Legacy-клиент 2025-11-25 обслуживается stateless-fallback’ом; отдельная сессия не нужна.

## 2. Эксперимент A: сколько ходов съедает поллинг

Сервер: `expA_polling/server.mjs`, прогон: `expA_polling/run.mjs`.
Инструменты `start_job`, `get_job_status(taskId, waitMs)`, `cancel_job`. Один ход = один вызов
инструмента, шаг модели 300 мс, 5 повторов на ячейку, медианы. Время ускорено в 10 раз:
задачи 0,5 / 4 / 18 с вместо 5 / 40 / 180 с, бюджет ожидания 2,5 с вместо 25 с.

| Задача (боевая) | Без ожидания | Long-poll 25 с | Выигрыш | Время до результата, poll / long-poll |
|---|---:|---:|---:|---:|
| 5 с | 4 хода (3–4) | 2 | 2,0× | 704 / 624 мс |
| 40 с | 16 (14–16) | 3 | 5,3× | 4270 / 4101 мс |
| 180 с | 63 (62–63) | 8 | 7,9× | 18 368 / 18 124 мс |

Оценка контекста. Если клиент на каждом ходу отправляет всю историю, объём текста tool-результатов
растёт как O(N²). Для 180-секундной задачи: около 428 КБ против 7,4 КБ — разница ~57×.
Это оценка только по tool-результатам, без системного промпта и рассуждений, но порядок величины
показывает, почему «просто поллинг» дороже, чем кажется.

Оговорки: считались вызовы, а не токены и не деньги; «модель» — детерминированный цикл,
а не живая LLM. Цифры задают порядок величины, а не заменяют замер на вашем клиенте.

## 3. Эксперимент B: падение процесса

Сервер: `expB_crash/server.mjs`, воркер: `worker.mjs`, прогон: `run.mjs`.
Задача 30 с, сервер убивается через 3 с (побочный эффект наступает на 2-й секунде), поднимается
заново, дальше статус поллится до терминального состояния (таймаут 10–45 с).
Для вариантов 5–6 сервер убивается на 5-й секунде (воркер должен успеть стартовать) и вместе с ним
убивается внешний воркер — имитация потери контейнера. В варианте 4 воркер переживает рестарт.

| Вариант | Статус после рестарта | Эффект | Что это значит |
|---|---|---:|---|
| 1. Память процесса | `unknown` (3/3) | 0 | задача пропала |
| 2. Файл, без детектора | `working` (3/3) | 1 | запись жива, воркера нет, обновлений не будет |
| 3. Файл + heartbeat | `failed`, «worker lost (stale heartbeat)» (3/3) | 1 | честный провал, работа не возвращается |
| 4. Внешний воркер | `completed` (2/2) | 1 | сервер пережил рестарт, работа продолжилась |
| 5. Recovery + идемпотентность | `completed` (2/2) | 1 | задача перезапущена, эффект не продублирован |
| 6. Recovery без идемпотентности | `completed` (2/2) | 2 | побочный эффект выполнен дважды |

Гонки, которые пришлось убрать, чтобы таблица воспроизводилась:

- **Момент убийства.** При `killAt = 1,5 с` побочный эффект (2-я секунда) не успевал записаться,
  и B2/B3 давали `eff=0`. Теперь `killAt = 3 с`.
- **Ожидание результата.** Фиксированная пауза 25 с не дотягивала до конца 30-секундной задачи,
  и B4 показывал `working`. Теперь статус поллится до терминального состояния.
- **Boot scan в recovery.** Сразу после рестарта heartbeat ещё свежий, задача не перезапускалась,
  а чтение статуса успевало пометить её `failed`. Теперь boot scan ждёт протухания heartbeat
  (до 10 с), а детектор по чтению статуса работает только в режиме `file-heartbeat`.

Фактические числа последнего прогона (`results-all.json`): B1 — 19 поллингов / ~10,1 с, B2 — то же,
B3 — 2 поллинга / ~0,6 с, B4 — 51 / ~26,6 с, B5 — 59 / ~30,8 с, B6 — 59 / ~30,9 с.

Главный вывод: внешнее хранилище само по себе не спасает. В варианте 1 сервер после рестарта отвечает
`Unknown or expired taskId` — формально корректно, но для клиента неотличимо от опечатки. Вариант 2
хуже варианта 1: клиент честно поллит «работающую» задачу, которой уже нет. Нужен heartbeat, детектор
потерянного воркера, очередь с lease и идемпотентный перезапуск. Если операция имеет побочные
эффекты — флаг `effectsCommitted` или outbox, иначе повтор после таймаута выполнит действие дважды
(вариант 6).

## 4. Аудит SDK

| SDK | Версия | Ядро 2026-07-28 | Tasks | Чем проверено |
|---|---|---|---|---|
| TypeScript | `@modelcontextprotocol/server` 2.4.0 | да | нет серверного рантайма: 0 упоминаний extension id в dist | npm + grep; `ext-tasks` 0.2.3 — клиент/протокол/receiver 2025-11-25 |
| Python | `mcp` 2.3.0 | да | нет: 0 упоминаний extension id; `tasks/update` и `tasks/cancel` отсутствуют | wheel + grep; есть инфраструктура `MethodBinding`, но не сам Tasks |
| C# | `ModelContextProtocol.Extensions.Tasks` 2.4.0 | да | да: `WithTasks(store)`, `tasks/get/update/cancel`, `IMcpTaskStore` | NuGet + XML-документация + 12 живых прогонов |
| Rust | `rmcp` 3.11.0 | да | да: `TaskManager`, `CreateTaskResult`, `tasks/get/update/cancel`, примеры | исходники + живой прогон примеров |
| Java | `io.modelcontextprotocol.sdk:mcp` 2.2.0 | да (modern) | нет: 0 вхождений extension id в трёх jar’ах (773 записи, 720 `.class`) | живой клиент+сервер по stdio + сканирование jar |
| Go | `go-sdk` 1.8.0 | да | нет: в пакете `mcp` нет ни extension id, ни `CreateTaskResult` | живой клиент+сервер по stdio + grep |

Детали, которые важны на практике:

- **TypeScript.** `ext-tasks` 0.2.3 — это `client`, `core`, `core/v1`, `core/v2`, `receiver`.
  `receiver` обслуживает *старые* Tasks 2025-11-25 для sampling/elicitation, а не серверный
  рантайм 2026-07-28. В v2 остались только deprecated wire-типы `tasks/get`; клиент бросает
  `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`, если попытаться отправить `tasks/get` пиру 2026-07-28.
- **Python.** В 2.3.0 есть механизм расширений (`MethodBinding`), то есть Tasks можно
  реализовать руками, но готового нет.
- **C#.** По умолчанию `ExecutionModeSelector` возвращает `Optional` для всех инструментов:
  любой инструмент становится task-capable, если клиент заявил расширение. Работа выполняется
  в фоне в том же процессе («executes the work in the background» в XML-документации
  `IMcpTaskStore`). Нужны постоянное хранилище и внешняя очередь.
- **Rust.** `rmcp` реализует расширение целиком: `ClientCapabilities::builder().enable_tasks()`,
  `TaskManager::spawn`, `CallToolResponse::Task(CreateTaskResult::new(task))`, примеры
  `servers_task_stdio` и `clients_task_stdio`. Это второй готовый серверный рантайм после C#.
- **Java.** Modern-ядро в 2.2.0 есть, расширений нет: в трёх артефактах (`mcp`, `mcp-core`,
  `mcp-json-jackson3`) ни одного вхождения `io.modelcontextprotocol/tasks`, `tasks/get`,
  `tasks/update`, `tasks/cancel`, `CreateTaskResult`, `TaskManager`, `TaskStore`.

### 4.1. C#: живой прогон

Сервер: `expD_csharp/Server` (`WithTasks(new InMemoryMcpTaskStore())`, инструмент `slow_echo`
спит 1500 мс), клиент: `expD_csharp/Client`, транспорт stdio, .NET 10.0.404. Лог — `run.log`,
сводка — `results.json`.

| Метрика | Значение |
|---|---|
| Согласованная версия | `2026-07-28` (12/12) |
| `capabilities.extensions` сервера | `io.modelcontextprotocol/tasks` |
| `CallToolAsTaskAsync` | `isTask=True`, `status=Working`, `pollIntervalMs=1000` (12/12) |
| `CallToolWithPollingAsync`, медиана | 2118 мс (2065–2135) |
| Обычный `CallToolAsync` без opt-in, медиана | 1525,5 мс (1521–1571) |
| Накладные расходы Tasks | ≈ 0,6 с, то есть примерно один интервал поллинга |

Одна аномалия вне этих 12 запусков: задача не создалась, вызов ушёл синхронно за 1548 мс.
Похоже на таймаут discovery-пробы на холодном старте и откат на `2025-11-25`; в 12 записанных
прогонах не воспроизвелось.

### 4.2. Go: живой прогон

Клиент и сервер: `expC_go`, `go-sdk` 1.8.0, Go 1.27.4, stdio (клиент запускает тот же бинарник
в режиме `-server`). Лог — `run.log`, сводка — `results.json`.

- согласован `2026-07-28`;
- `serverInfo.name = go-echo`, capabilities: `logging`, `tools.listChanged`;
- `tools/list` вернул `echo`, `tools/call` вернул `isError=false`;
- API задач нет: grep по пакету `mcp` не находит `io.modelcontextprotocol/tasks`,
  `CreateTaskResult` или `TaskManager`.

### 4.3. Rust: живой прогон

Примеры `rmcp` 3.11.0 (`clients_task_stdio` + `servers_task_stdio`), Rust 1.100.0, target
`x86_64-pc-windows-gnu`, линкер MinGW. Лог — `expE_rust/run.log`, сводка — `expE_rust/results.json`.

- согласована версия `2025-11-25`: примеры `rmcp` ещё не перешли на `2026-07-28`, расширение
  работает поверх 2025-11-25;
- клиент объявил `io.modelcontextprotocol/tasks`, сервер его принял;
- `quick_echo` ответил синхронно (`isTask=false`);
- `slow_sum` вернул `CreateTaskResult`, клиент поллил `tasks/get` и получил `Completed`
  с `resultType: "complete"` и текстом `42`;
- первая сборка зависимостей — около 46 минут (362 крейта).

### 4.4. Java: живой прогон

Клиент и сервер: `expF_java`, `io.modelcontextprotocol.sdk:mcp` 2.2.0, Temurin JDK 21.0.13.1,
Maven 3.10.2, stdio (клиент запускает `expf.Server` на том же classpath). Лог — `run.log`,
сводка — `results.json`.

- `discover()` вернул `supportedVersions: ["2026-07-28"]`, `capabilities.tools`, `ttlMs: 0`,
  `cacheScope: PRIVATE`, `extensions: null`;
- `tools/list` вернул `echo`, `tools/call` вернул текст без ошибки (`isError=null`);
- Tasks нет: сканирование трёх jar’ов (773 записи, 720 `.class`) дало 0 вхождений `io.modelcontextprotocol/tasks`,
  `tasks/get`, `tasks/update`, `tasks/cancel`, `tasks/list`, `CreateTaskResult`, `TaskManager`,
  `TaskStore`.

Запуск: `experiments/expF_java/run.ps1 -JavaHome <JDK> -MavenHome <Maven>`.

## 5. Клиенты и таймауты

Это по-прежнему вторичные данные, сами клиенты мы не тестировали.

- **Claude Code CLI** — публичная бета с 2.1.304, объявлено 22 октября на AGNTCon + MCPCon.
  Работает в интерактивном терминале, Agent SDK и GitHub Actions. Не работает: субагенты,
  одноразовый `claude -p`, VS Code-расширение и десктопное приложение (Upstash, 23 октября).
- **Остальные.** По наблюдениям Upsy (24 октября) ChatGPT, Codex, Cursor, Claude Desktop и
  VS Code расширение не заявляют Tasks и продолжают жить с обычным таймаутом; по claude.ai данные
  расходятся — в матрице на 28 октября Tasks у Claude (web) указаны. Матрица Upstash на 7 октября:
  ChatGPT, Codex, Claude Code, Cursor, OpenCode — без Tasks; C# и Rust SDK — с Tasks, TypeScript и
  Python — без.
- **Таймауты.** В `@modelcontextprotocol/server` 2.4.0 `DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000`,
  `resetTimeoutOnProgress` по умолчанию выключен. Вендорский changelog сообщает о фиксированных
  60 с у Claude Desktop и Cursor. Практическое правило: любое ожидание внутри одного вызова
  должно укладываться заметно ниже 60 с; мы держим потолок 35 с.

## 6. Что в прод, а что нет

| Решение | Вердикт | Почему |
|---|---|---|
| Stateless-ядро 2026-07-28 в dual-era режиме | в прод | зонды 1–6 прошли, старые клиенты не ломаются |
| Валидация `Mcp-Method`/`Mcp-Name` на сервере и шлюзе | в прод | SDK возвращает `-32020`, зонды 3–4, 8–10 |
| Миграция с roots, sampling, logging | в план | deprecated, окно 12 месяцев |
| Нативные Tasks на C# и Rust | с оговорками | рантайм есть, но воркер по умолчанию в том же процессе; нужны хранилище и очередь |
| Нативные Tasks на TypeScript и Python | не в прод | серверного рантайма нет |
| Расчёт на то, что клиент сам поллит `tasks/get` | не в прод | массовые клиенты расширение не заявляют, кроме беты Claude Code CLI |
| Гибрид: инструменты + запись в форме Tasks + адаптер позже | в прод | работает везде, эксперимент A |
| Ожидание внутри вызова дольше 35–40 с | не в прод | дефолт SDK 60 с и сообщения о 60 с у клиентов |
| Операции в памяти процесса | не в прод | эксперимент B, вариант 1 |
| Внешнее хранилище без heartbeat | не в прод | эксперимент B, вариант 2 — худший |
| Внешний воркер + lease + идемпотентность | в прод, если есть очередь | эксперимент B, варианты 4–5 |
| MCP Events и вебхуки OpenAI | наблюдать | черновик, нет эталонной реализации |

## 7. Что мы не смогли подтвердить

- «Production-телеметрия» с 45-секундным бюджетом и 22 вызовами дольше 60 с из обсуждения
  python-sdk#2806: issue не открывался из-за rate limit GitHub API, цифры нигде не подтверждены.
- «Конфликт `pollIntervalMs` и окна очистки осиротевших задач (§6.4)»: в тексте спецификации
  Tasks слова «orphan» нет (проверено grep по SEP-2663), источник не найден.
- Точные таймауты коннекторов claude.ai (около 240 и 311 с): цифр в проверенных материалах нет.
- Поведение адаптеров LangChain и GigaChain с Tasks.
- Матрица клиентов на 28 октября — пересказ в стороннем блоге, официальную страницу не открывали.

## 8. Как воспроизвести

```
experiments/
  exp0_probe/     node probe.mjs      # 13 зондов, results.json
  expA_polling/   node run.mjs        # 45 прогонов, results.json
  expB_crash/     node run.mjs        # 6 сценариев, results-all.json
  expC_go/        go run .            # клиент+сервер, results.json
  expD_csharp/    dotnet run ...      # клиент+сервер с Tasks, results.json
  expE_rust/      cargo run ...       # примеры rmcp, run.log
  expF_java/      run.ps1             # клиент+сервер на Java SDK, results.json
```

Все прогоны сразу: `powershell -ExecutionPolicy Bypass -File experiments/run-all.ps1`
(логи — в `experiments/logs/`).

Версии зафиксированы в `experiments/package.json` (Node), `expC_go/go.mod`, `expD_csharp/*/*.csproj`,
`expF_java/pom.xml` и в теге `rmcp-v3.11.0` для Rust; сводка версий — `experiments/versions.json`.
Эксперимент B убивает процессы через `taskkill /F`; на Windows с антивирусом старт и kill могут
занимать секунды. Поэтому в вариантах 1–2 статус не становится терминальным и поллинг упирается
в таймаут 10 с — это видно по `waitedMs` в `results-all.json`, на выводы не влияет.

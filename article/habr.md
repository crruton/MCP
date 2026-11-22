Мы подняли сервер на TS SDK v2, отправили в него 13 зондов, прогнали 45 замеров поллинга и шесть
сценариев падения процесса. Ниже — что подтвердилось, что сломалось и что из этого можно брать в прод.

Данные на 20–22 ноября 2026. Всё, что можно было проверить руками, проверено в песочнице; скрипты,
логи и сырые результаты лежат в репозитории к статье. Всё, что проверить не удалось, помечено как
«со слов источника» или вынесено в раздел «Что мы не смогли подтвердить».

**TL;DR**

- Stateless-ядро 2026-07-28 можно брать в прод. Мы подняли сервер на TypeScript SDK 2.4.0 и прогнали
  13 HTTP-зондов: `server/discover`, зеркалирование заголовков (`-32020`), неподдерживаемая версия
  (`-32022`), legacy-fallback 2025-11-25 — всё работает как описано.
- Расширение Tasks в спецификации готово, а в SDK — не везде. В TypeScript 2.4.0 и Python 2.3.0 нет
  серверного рантайма Tasks. Готовые рантаймы есть в C# (`ModelContextProtocol.Extensions.Tasks` 2.4.0)
  и Rust (`rmcp` 3.11.0). C# мы проверили живьём: 12 из 12 запусков создали задачу, поллинг завершил
  её за ~2,1 с при работе инструмента 1,5 с. Rust тоже прогнан: `slow_sum` вернул `CreateTaskResult`,
  поллинг дал `Completed` с результатом `42`. Java и Go — без Tasks, обе проверены живыми прогонами.
- Клиентов, которые сами поллят `tasks/get`, мало. По источникам на октябрь–ноябрь это Claude Code CLI
  в публичной бете. ChatGPT, Codex, Cursor, Claude Desktop и VS Code расширение Tasks не заявляют,
  а по claude.ai данные источников расходятся.
- В проде нужен гибрид: обычные инструменты `start` / `get_status` / `cancel`, запись операции в форме
  Tasks и нативный адаптер «потом». В нашем эксперименте long-poll внутри `get_status` сократил число
  ходов модели с 63 до 8 на задаче в 180 секунд — в 7,9 раза.
- Вынести состояние из процесса мало. Если воркер живёт в том же контейнере, статус переживёт рестарт,
  а сама работа нет. Нужны очередь, lease, heartbeat и идемпотентный перезапуск. Без идемпотентности
  восстановленная задача выполнила побочный эффект дважды — мы это воспроизвели.

<cut>

## Как мы проверяли

- Склонировали репозитории спецификации (`modelcontextprotocol`) и расширения (`ext-tasks`) и читали
  первоисточник, а не пересказы.
- Поставили `@modelcontextprotocol/server` 2.4.0 (TypeScript), `mcp` 2.3.0 (Python), посмотрели
  `ModelContextProtocol.Extensions.Tasks` 2.4.0 (C#) и `rmcp` 3.11.0 (Rust).
- Подняли локальный сервер на TS SDK v2 и отправили в него 13 HTTP-зондов.
- Собрали и прогнали клиент и сервер на Go SDK 1.8.0 по stdio, а на C# — сервер с Tasks и клиент
  с поллингом; оба согласовали версию 2026-07-28. Отдельно подняли JDK 21 и Maven 3.10.2 и прогнали
  такой же клиент и сервер на Java SDK 2.2.0.
- Написали гибридный сервер и провели два эксперимента: число ходов при поллинге и поведение при
  падении процесса. Все прогоны повторялись, в таблицах — медианы.
- Прочитали исходники C# SDK, Rust SDK и свежий `main` открытого MCP-сервера `ptai-mcp`.

Ограничения. GitHub API в песочнице иногда упирался в rate limit, поэтому часть issue мы не открывали
напрямую. Поддержку Tasks в клиентах мы не тестировали сами: это данные из публикаций и трекеров.
Эксперимент с «моделью» — детерминированный цикл вызовов, а не живая LLM. Go, C#, Rust и Java
мы запускали по-настоящему; вторичные данные остались только по клиентам.

## 1. Что изменилось в ревизии 2026-07-28

Протокол стал stateless. Рукопожатие `initialize` и протокольная сессия `Mcp-Session-Id` удалены.
Каждый запрос самодостаточен и несёт версию протокола и capabilities клиента в `params._meta` (ключи
`io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities`, `.../clientInfo`). Серверы можно
балансировать обычным round-robin, без sticky-сессий.

Маршрутизация по заголовкам. Для Streamable HTTP обязательны `Mcp-Method` и `Mcp-Name`. `Mcp-Name`
дублирует `params.name` (для `tools/call`, `prompts/get`) или `params.uri` (для `resources/read`).
Расхождение заголовка и тела — HTTP 400 с JSON-RPC кодом `-32020`. Для `tasks/*` `Mcp-Name` равен
`params.taskId`.

Коды ошибок перенумерованы. По changelog: `HeaderMismatch` стал `-32020` (был `-32001`),
`MissingRequiredClientCapability` — `-32021` (был `-32003`), `UnsupportedProtocolVersion` — `-32022`
(был `-32004`). Диапазон `-32020…-32099` зарезервирован за спецификацией, кастомные коды в нём
использовать нельзя.

Deprecation. Roots, sampling и logging объявлены устаревшими с окном в двенадцать месяцев. Заодно
появились подсказки кеширования в ответах. В нашем зонде `server/discover` вернул `ttlMs: 0` и
`cacheScope: "private"`: это решение сервера, а не требование протокола — в примере спецификации
стоят `3600000` и `public`.

Расширения. Tasks и MCP Apps вынесены из ядра в официальные расширения со своим циклом релизов.

## 2. Tasks по спецификации

Идентификатор расширения: `io.modelcontextprotocol/tasks` (SEP-2663). Идея: сервер возвращает
долговечный handle вместо блокировки, клиент поллит.

Согласование. Клиент добавляет `io.modelcontextprotocol/tasks` в
`_meta.io.modelcontextprotocol/clientCapabilities.extensions` каждого запроса. Сервер объявляет то же
в `server/discover`. Решение «создавать ли task» принимает сервер и только для клиента, который заявил
расширение. Если сервер без Tasks обойтись не может, он отвечает `-32021`.

Жизненный цикл: `tools/call` → `CreateTaskResult` (`resultType: "task"`) → клиент поллит `tasks/get`
с интервалом `pollIntervalMs` → терминальный статус с результатом внутри ответа.

```json
{
  "jsonrpc": "2.0", "id": 10,
  "result": {
    "resultType": "task",
    "taskId": "tsk_01JCK8Q9W7V3M2Z4P6X8R0N1B5",
    "status": "working",
    "ttlMs": 3600000,
    "pollIntervalMs": 5000
  }
}
```

Безопасность. `tasks/list` убран намеренно: чужие задачи нельзя перечислить. Но `taskId` может быть
bearer-токеном на результат, поэтому он должен быть непредсказуемым (мы используем 128 бит энтропии),
а проверка принципала нужна на каждом вызове. Неизвестный или протухший `taskId` — это `-32602`;
сервер не обязан хранить задачи вечно. Поддерживается пока только `tools/call`. Push-уведомления
`notifications/tasks` приходят через `subscriptions/listen` по opt-in.

Разные эпохи несовместимы по wire. Новые Tasks несовместимы с экспериментальными из ноября 2025:
код, написанный под старые, придётся переписывать, а не обновлять.

| Что | Экспериментальные Tasks (2025-11-25) | Расширение (2026-07-28) |
|---|---|---|
| Где живёт | в ядре спецификации | отдельное расширение |
| Кто решает создать task | клиент | сервер, если клиент заявил расширение |
| Методы | `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` | `tasks/get`, `tasks/update`, `tasks/cancel` (`tasks/list` и `tasks/result` убраны) |
| Результат | отдельный блокирующий `tasks/result` | инлайн в `tasks/get` |
| Ввод посреди задачи | через `tasks/result` | `inputRequests` в `tasks/get`, ответ через `tasks/update` |
| `isError: true` у инструмента | зависит от реализации | статус `completed`, ошибка внутри `result`; `failed` — только для JSON-RPC-ошибок |
| Отмена | кооперативная | кооперативная, ответ — пустой ack |
| Заголовок `Mcp-Name` | не использовался | равен `params.taskId` на `tasks/get`, `tasks/update`, `tasks/cancel` |

## 3. Аудит SDK: кто готов, а кто нет

| SDK | Версия | Ядро 2026-07-28 | Tasks | Чем проверено |
|---|---|---|---|---|
| TypeScript | `@modelcontextprotocol/server` 2.4.0 | да | нет серверного рантайма: 0 упоминаний extension id в dist | npm + grep; `ext-tasks` 0.2.3 — клиент/протокол/receiver 2025-11-25 |
| Python | `mcp` 2.3.0 | да | нет: 0 упоминаний extension id; `tasks/update` и `tasks/cancel` отсутствуют | wheel + grep; есть `MethodBinding`, но не сам Tasks |
| C# | `ModelContextProtocol.Extensions.Tasks` 2.4.0 | да | да: `WithTasks(store)`, `tasks/get/update/cancel`, `IMcpTaskStore` | NuGet + XML-документация + 12 живых прогонов |
| Rust | `rmcp` 3.11.0 | да | да: `TaskManager`, `CreateTaskResult`, `tasks/get/update/cancel` | исходники + живой прогон примеров |
| Java | `io.modelcontextprotocol.sdk:mcp` 2.2.0 | да | нет: 0 вхождений extension id в трёх jar’ах | живой клиент+сервер по stdio + сканирование jar |
| Go | `go-sdk` 1.8.0 | да | нет: в пакете `mcp` нет ни extension id, ни `CreateTaskResult` | живой клиент+сервер по stdio + grep |

Что это значит. Два самых массовых стека для серверов, TypeScript и Python, нативных серверных Tasks
сейчас не дают. Если вы пишете на них, `tasks/get` придётся реализовывать самим поверх низкоуровневого
API, и вы берёте на себя совместимость с будущим SDK. Для стека без готового рантайма это решение не
про «включить флаг», а про архитектуру хранилища и воркеров (раздел 8).

Несколько нюансов, которые видно только в исходниках:

- **TypeScript.** `ext-tasks` 0.2.3 — это `client`, `core`, `core/v1`, `core/v2`, `receiver`.
  `receiver` обслуживает старые Tasks 2025-11-25 для sampling/elicitation, а не серверный рантайм
  2026-07-28. В v2 остались только deprecated wire-типы `tasks/get`; клиент бросает
  `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`, если попытаться отправить `tasks/get` пиру 2026-07-28.
- **Python.** В 2.3.0 есть механизм расширений (`MethodBinding`), то есть Tasks можно реализовать
  руками, но готового нет. В ROADMAP — «deferred», трекер #2806.
- **C#.** По умолчанию `ExecutionModeSelector` возвращает `Optional` для всех инструментов: любой
  инструмент становится task-capable, если клиент заявил расширение. Работа выполняется в фоне
  в том же процессе («executes the work in the background» в документации `IMcpTaskStore`).
  Есть режимы `Synchronous` / `Optional` / `Required` и интерфейс `IMcpTaskStore`.
- **Rust.** `rmcp` реализует расширение целиком: `ClientCapabilities::builder().enable_tasks()`,
  `TaskManager::spawn`, `CallToolResponse::Task(CreateTaskResult::new(task))`, примеры
  `servers_task_stdio` и `clients_task_stdio`. Это второй готовый серверный рантайм после C# —
  в прошлой версии статьи мы его не проверяли.
- **Java.** В 2.2.0 есть modern-ядро (`io.modelcontextprotocol.modern.*`), но расширений нет:
  в трёх артефактах ни одного вхождения `io.modelcontextprotocol/tasks`, `tasks/get`,
  `tasks/update`, `tasks/cancel`, `CreateTaskResult`, `TaskManager`, `TaskStore`.

**Живой прогон C#.** Мы собрали сервер с `WithTasks(new InMemoryMcpTaskStore())` и инструментом,
который спит 1,5 с, и клиент на `ModelContextProtocol` 2.4.0. Клиент и сервер общаются по stdio,
.NET 10.0.404. В 12 из 12 запусков согласовалась версия `2026-07-28`, сервер объявил
`capabilities.extensions: io.modelcontextprotocol/tasks`, а `CallToolAsTaskAsync` вернул
`isTask=True`, `status=Working`, `pollIntervalMs=1000`. Полный цикл `CallToolWithPollingAsync`
занял медианно 2118 мс (2065–2135), то есть 1,5 с работы инструмента плюс примерно один интервал
поллинга. Обычный `CallToolAsync` без opt-in уложился в 1525,5 мс (1521–1571) и вернул тот же
результат синхронно: накладные расходы Tasks — около 0,6 с. В одном отдельном холодном запуске
задача не создалась и вызов ушёл синхронно; похоже, discovery-проба не уложилась в таймаут, и клиент
откатился на `2025-11-25`. Это воспроизводимая ошибка конфигурации, а не свойство протокола, но
холодный старт стоит держать в бюджете.

**Живой прогон Rust.** Собрали примеры `rmcp` 3.11.0 (`clients_task_stdio` и `servers_task_stdio`),
Rust 1.100.0, target `x86_64-pc-windows-gnu`. Клиент объявил `io.modelcontextprotocol/tasks`,
сервер его принял; `quick_echo` ответил синхронно, а `slow_sum` вернул `CreateTaskResult`, клиент
поллил `tasks/get` и получил `Completed` с `resultType: "complete"` и текстом `42`. Одна деталь:
примеры `rmcp` согласовали `2025-11-25`, а не `2026-07-28` — расширение работает и поверх старой
версии протокола. Первая сборка зависимостей заняла около 46 минут (362 крейта), так что в CI
этот прогон мы не включали.

**Живой прогон Go.** Клиент и сервер на `go-sdk` 1.8.0 (Go 1.27.4) по stdio согласовали
`2026-07-28`, `tools/list` вернул `echo`, `tools/call` прошёл без ошибки. API задач в пакете `mcp`
нет вообще: grep не находит ни `io.modelcontextprotocol/tasks`, ни `CreateTaskResult`, ни
`TaskManager`. Go отстаёт не по версии протокола, а по расширению, поэтому Tasks там придётся
строить руками поверх низкоуровневых обработчиков.

**Живой прогон Java.** Поставили Temurin JDK 21.0.13.1 и Maven 3.10.2, собрали сервер на
`io.modelcontextprotocol.sdk:mcp` 2.2.0 с одним инструментом `echo` и клиент к нему, транспорт stdio.
Клиент вызвал `discover()` и получил `supportedVersions: ["2026-07-28"]`, `capabilities.tools`,
`ttlMs: 0`, `cacheScope: PRIVATE` и `extensions: null`; `tools/list` вернул `echo`, `tools/call`
вернул текст без ошибки. То есть modern-ядро в Java SDK работает так же, как в TS и Go. Расширения
Tasks нет: мы распаковали `mcp-2.2.0.jar`, `mcp-core-2.2.0.jar` и `mcp-json-jackson3-2.2.0.jar`
(773 записи, из них 720 `.class`) и не нашли ни одного вхождения `io.modelcontextprotocol/tasks`, `tasks/get`,
`tasks/update`, `tasks/cancel`, `CreateTaskResult`, `TaskManager` или `TaskStore`. Это согласуется
с release notes 2.2.0 («extensions are not supported yet»), но теперь проверено кодом, а не только
текстом релиза.

## 4. Эксперимент 0: 13 зондов живого сервера

Мы подняли минимальный сервер на TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0 и
`@modelcontextprotocol/node` 2.1.2) и отправили в него 13 запросов по HTTP.

```ts
import http from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
  const s = new McpServer({ name: 'probe', version: '0.0.1' });
  s.registerTool('echo', { description: 'echo', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: 'text', text }] }));
  return s;
});
http.createServer(toNodeHandler(handler)).listen(3000, '127.0.0.1');
```

| № | Запрос | HTTP | Код | Что означает |
|---|---|---|---|---|
| 1 | `server/discover` + Tasks в clientCapabilities | 200 | — | `supportedVersions: ["2026-07-28"]`, `capabilities.tools`, `ttlMs: 0`, `cacheScope: "private"`, расширений нет |
| 2 | `tools/call` с верными заголовками | 200 | — | `resultType: "complete"` |
| 3 | `Mcp-Name: foo` при `params.name = echo` | 400 | -32020 | есть `data.mismatch` с header/body |
| 4 | `Mcp-Method: tools/list` при методе `tools/call` | 400 | -32020 | то же |
| 5 | версия `1900-01-01` в заголовке и `_meta` | 400 | -32022 | `data: {supported: ["2026-07-28"], requested: "1900-01-01"}` |
| 6 | legacy `initialize` 2025-11-25 | 200 | — | SSE-ответ, `protocolVersion: "2025-11-25"` |
| 6b | legacy `tools/call` после initialize | 200 | — | stateless-fallback обслуживает и следующий запрос |
| 7 | `tasks/get` на сервере без Tasks | 404 | -32601 | Method not found |
| 8 | нет `Mcp-Method` | 400 | -32020 | «required Mcp-Method header is absent» |
| 9 | нет `Mcp-Name` на `tools/call` | 400 | -32020 | «required Mcp-Name header is absent» |
| 10 | заголовок 2026-07-28, `_meta` 2025-11-25 | 400 | -32020 | версия сверяется и между заголовком и телом |
| 11 | `tasks/list` | 404 | -32601 | метода нет |
| 12 | инструмент с задержкой 1 с | 200 | — | ответ за 1,1 с, `resultType: "complete"` |

Пример рабочего запроса (все три заголовка обязательны, `_meta` несёт версию и capabilities):

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: echo' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Итог: заявленное в спецификации поведение ядра реально работает в SDK, включая валидацию заголовков.
Этим зондом удобно проверять и чужие серверы: если сервер на заголовочный mismatch отвечает 200, он
не валидирует зеркалирование. Отсутствие обязательного заголовка — тот же `-32020`, что и расхождение.
А `tasks/get` на сервере без Tasks даёт 404/-32601, и клиент обязан уметь откатиться на обычный вызов.

## 5. Клиенты и таймауты

Что известно про поддержку Tasks на стороне клиентов (мы это не тестировали, данные из публикаций):

- **Claude Code.** CLI поддерживает Tasks в публичной бете с версии 2.1.304. О поддержке объявили на
  AGNTCon + MCPCon 22 октября, разбор вышел у Upstash 23 октября. Работает в интерактивном терминале,
  Agent SDK и GitHub Actions. Не работает: субагенты, одноразовый `claude -p`, VS Code-расширение и
  десктопное приложение.
- **Остальные.** По наблюдениям Upsy (24 октября) ChatGPT, Codex, Cursor, claude.ai, Claude Desktop и
  VS Code расширение не объявляют Tasks и продолжают жить с обычным таймаутом. Матрица Upstash на
  7 октября: ChatGPT, Codex, Claude Code, Cursor, OpenCode — без Tasks; C# и Rust SDK — с Tasks,
  TypeScript и Python — без. Про claude.ai источники расходятся: в одной матрице на 28 октября Tasks
  у Claude (web) есть. Официальную страницу мы не открывали.
- **OpenAI** пошла другим путём: по данным Upstash, с 29 сентября ChatGPT поддерживает push-модель
  MCP Events (вебхуки). Это черновик спецификации, а не часть 2026-07-28.

Таймауты (проверено нами). В `@modelcontextprotocol/server` 2.4.0 константа
`DEFAULT_REQUEST_TIMEOUT_MSEC` равна `60_000`, а у клиента есть опция `resetTimeoutOnProgress`.
По обсуждению в трекере python-sdk она по умолчанию выключена. Отдельный вендорский changelog
(customaise-mcp v3.2.0, 28 августа) сообщает, что Claude Desktop и Cursor режут вызов на фиксированных
60 секундах независимо от progress. Это одно свидетельство, но оно согласуется с дефолтом SDK.
Практический вывод: любое ожидание внутри одного вызова должно укладываться заметно ниже 60 секунд;
мы держим потолок 35 секунд.

## 6. Эксперимент A: ходы, контекст и long-poll

Гипотеза. Если инструмент статуса умеет ждать на сервере (long-poll), число ходов модели на долгой
задаче падает в разы. У модели нет встроенного `sleep`: каждый пустой ответ `working` стоит ход.

Постановка. Гибридный сервер с тремя инструментами: `start_job`, `get_job_status(taskId, waitMs)` и
`cancel_job`. Клиент имитирует модель: один ход равен одному вызову, шаг 0,3 с, считаем вызовы до
`completed`. Время ускорено в 10 раз относительно боевых значений (задачи 0,5 / 4 / 18 с вместо
5 / 40 / 180 с, бюджет ожидания 2,5 с вместо 25 с), отношения сохранены. По 5 повторов на ячейку,
в таблице медианы.

| Задача (боевая) | Без ожидания | Long-poll 25 с | Выигрыш | Время до результата, poll / long-poll |
|---|---:|---:|---:|---:|
| 5 с | 4 хода (3–4) | 2 | 2,0× | 704 / 624 мс |
| 40 с | 16 (14–16) | 3 | 5,3× | 4270 / 4101 мс |
| 180 с | 63 (62–63) | 8 | 7,9× | 18 368 / 18 124 мс |

Число ходов упало в 2, 5,3 и 7,9 раза. Время до результата не ухудшилось: long-poll даже чуть
быстрее, потому что последний вызов возвращается сразу по завершении задачи, не дожидаясь шага
клиента. Идеализированные 61/15/3 хода из первой версии статьи воспроизводятся, если считать вызовы
мгновенными; в реальном HTTP каждый запрос добавляет десятки миллисекунд, и за 18 секунд набегает
ещё пара ходов.

Отдельный эффект — контекст. Если клиент на каждом ходу отправляет всю историю, объём текста
tool-результатов растёт как O(N²). Для 180-секундной задачи это около 428 КБ против 7,4 КБ, разница
~57×. Это оценка только по tool-результатам, без системного промпта и рассуждений, но порядок
величины показывает, почему «просто поллинг» дороже, чем кажется.

**Что этот эксперимент не показывает.** Мы считали вызовы, а не токены и не стоимость. Живая LLM может
вести себя иначе: делать паузы, объединять шаги или, наоборот, повторять вызовы чаще. Цифры задают
порядок величины и подтверждают механизм, но не заменяют замер на вашей модели.

## 7. Эксперимент B: что происходит при падении сервера

Гипотеза. Вынос записи задачи из памяти процесса не спасает, если воркер живёт в том же процессе.
Это согласуется с документацией C# SDK: после создания задачи в хранилище сервер «executes the work
in the background» и записывает результат по завершении (`IMcpTaskStore`, XML-документация
`ModelContextProtocol.Extensions.Tasks` 2.4.0). Отдельного процесса или очереди там нет.

Постановка. Запускаем задачу на 30 с, через 3 с убиваем сервер (`taskkill /F`), поднимаем заново
и поллим статус до терминального состояния. Шесть вариантов:

1. хранилище в памяти;
2. файловое хранилище (замена Redis);
3. файловое хранилище плюс детектор потерянного воркера;
4. файловое хранилище плюс внешний воркер, который переживает рестарт сервера;
5. внешний воркер, recovery при старте и идемпотентный перезапуск;
6. то же, но без идемпотентности.

В вариантах 5–6 сервер убивается позже, на 5-й секунде, — нужно, чтобы внешний воркер успел стартовать, —
и вместе с сервером убивается сам воркер: так выглядит потеря контейнера или машины целиком. В
варианте 4 воркер, наоборот, переживает рестарт сервера.

Три гонки пришлось убрать, иначе таблица не воспроизводилась. Первая: при убийстве на 1,5 с побочный
эффект (2-я секунда) не успевал записаться, и варианты 2–3 давали нулевой эффект. Вторая: фиксированная
пауза 25 с не дотягивала до конца 30-секундной задачи, и вариант 4 показывал `working`. Третья: в
recovery сразу после рестарта heartbeat ещё свежий, задача не перезапускалась, а чтение статуса
успевало пометить её `failed`. Теперь убийство на 3-й секунде, статус поллится до терминального
состояния, а boot scan ждёт протухания heartbeat.

Детектор прост: воркер пишет heartbeat каждые 100 мс, а при чтении статуса запись `working` со старым
heartbeat (больше 1 с) помечается `failed`. В режиме recovery этот детектор отключён: там потерянного
воркера возвращает boot scan, иначе статус успевает стать `failed` раньше перезапуска.

| Вариант | Статус после рестарта | Эффект | Что это значит |
|---|---|---:|---|
| 1. Память процесса | `unknown` (3/3) | 0 | задача пропала |
| 2. Файл, без детектора | `working` (3/3) | 1 | запись жива, воркера нет, обновлений не будет |
| 3. Файл + heartbeat | `failed`, «worker lost (stale heartbeat)» (3/3) | 1 | честный провал, работа не возвращается |
| 4. Внешний воркер | `completed` (2/2) | 1 | сервер пережил рестарт, работа продолжилась |
| 5. Recovery + идемпотентность | `completed` (2/2) | 1 | задача перезапущена, эффект не продублирован |
| 6. Recovery без идемпотентности | `completed` (2/2) | 2 | побочный эффект выполнен дважды |

Вариант 2 самый опасный: клиент честно поллит «работающую» задачу, которой уже нет. Вариант 3 лишь
честно сообщает о провале, но саму работу не возвращает. Для настоящей устойчивости воркер нужно
вынести в отдельную очередь с lease и идемпотентным перезапуском. Вариант 6 показывает цену ошибки:
без флага `effectsCommitted` повторный запуск после таймаута выполнил деплой дважды. В варианте 1
сервер после рестарта отвечает `Unknown or expired taskId` — формально корректно, но для клиента это
неотличимо от опечатки в идентификаторе.

Оговорка про тайминги: в вариантах 1–2 статус никогда не становится терминальным, поэтому поллинг
упирается в таймаут 10 с — отсюда `waitedMs ≈ 10 000` в `results-all.json`. Это не задержка детектора,
а цена ожидания: клиент не знает, что ждать больше нечего. В варианте 3 heartbeat протухает за
~0,6 с, в вариантах 4–6 задача доходит до `completed` за 26–31 с. На выводы это не влияет: важна
не точность таймера, а то, что статус после рестарта честно отражает потерю воркера.

## 8. Референсная архитектура на конец 2026

**Принцип 1. Обычные инструменты поверх записи в форме Tasks.** Экспортируйте `start_*`,
`get_*_status`, `cancel_*`. Внутри храните ровно ту структуру, которую потом отдаст `tasks/get`:

```ts
type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

interface StoredTask {
  taskId: string;          // 128 бит энтропии, это bearer-токен на результат
  ownerPrincipal: string;  // sub/tenant из токена: проверка на каждом вызове
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  heartbeat: number;       // для детектора потерянного воркера
  leaseUntil?: number;     // кто и до какого момента владеет выполнением
  effectsCommitted?: number; // сколько побочных эффектов уже применено
  result?: unknown;        // CallToolResult при completed (в том числе isError: true)
  error?: { code: number; message: string }; // только JSON-RPC-ошибка при failed
}
```

В эксперименте проверки владельца не было. В проде она обязательна: `taskId` равен bearer-токену.

**Принцип 2. Long-poll внутри `get_status`, строго ниже 60 секунд.**

```ts
const cap = 35_000; // потолок ожидания
const deadline = Date.now() + Math.min(Math.max(waitMs, 0), cap);
for (;;) {
  let t = await store.get(taskId);
  if (!t || t.ownerPrincipal !== caller) return toolError('Unknown or expired taskId');
  if (t.status === 'working' && Date.now() - t.heartbeat > STALE_MS)
    t = await store.markFailed(taskId, 'worker lost (stale heartbeat)');
  if (isTerminal(t.status) || Date.now() >= deadline) return view(t);
  await sleep(100); // в проде: pub/sub или BLPOP вместо опроса стора
}
```

**Принцип 3. Хранилище и воркер раздельно.** Статус во внешнем хранилище (Redis, БД), выполнение в
очереди (BullMQ, Celery/ARQ, RabbitMQ, QStash). Воркер обновляет heartbeat, а перезапуск задачи
идемпотентен. Если операция имеет побочные эффекты, храните флаг вроде `effectsCommitted` или
используйте outbox, иначе повторный запуск после таймаута может выполнить действие дважды.

**Принцип 4. Нативный адаптер потом, поверх той же записи.** Когда клиент объявил расширение в
`_meta.io.modelcontextprotocol/clientCapabilities.extensions`, возвращайте `CreateTaskResult` с
`resultType: "task"` и обслуживайте `tasks/get`, `tasks/update`, `tasks/cancel` из того же хранилища.
Остальным клиентам отдавайте обычный путь через инструменты. Спецификация запрещает возвращать task
клиенту без объявленного расширения, так что схема аддитивна.

**Принцип 5. Dual-era на входе.** Пока клиенты не перешли с `initialize`, держите оба режима
(в TS SDK v2 это поведение `createMcpHandler` по умолчанию) и один набор инструментов на оба.

Чек-лист перед продом:

- [ ] `taskId` — криптостойкий, не перечисляемый, проверяется на каждом вызове вместе с принципалом.
- [ ] `waitMs` ограничен сверху (у нас 35 с) и не превышает клиентский таймаут.
- [ ] heartbeat и детектор потерянного воркера включены.
- [ ] воркер живёт вне процесса сервера и умеет lease/ack.
- [ ] побочные эффекты идемпотентны или закрыты outbox/флагом.
- [ ] есть fallback на обычный синхронный вызов для клиентов без расширения.
- [ ] `tasks/list` не реализован, `tasks/result` не используется.
- [ ] старые `taskSupport`/`task`-хинты 2025-11-25 не объявляются, если Tasks не реализован.

## 9. Разбор живого кода: ptai-mcp

Чтобы сверить теорию с реальностью, мы прочитали `POSIdev-community/ptai-mcp` (MCP-сервер к
статическому анализатору PT Application Inspector), свежий `main` от 17 ноября, релиз 1.1.0.
Это не критика: проект выпущен на SDK v1, а серверного рантайма Tasks в TypeScript SDK нет, так что
ситуация типична.

Протокол. SDK закреплён на `@modelcontextprotocol/sdk` 1.32.2 (максимум 2025-11-25); в `package.json`
он лежит в `devDependencies` и попадает в сборку через tsup. Сервер объявляет только `tools`,
`resources`, `prompts`, без расширений и методов `tasks/*`.

Артефакт старой эпохи. В `src/local/catalog.ts` на инструментах стоит
`execution.taskSupport: 'optional'` (формат 2025-11-25), хотя capability для Tasks сервер не объявляет.
Клиент видит обещание, которое выполнить нечем. Это единственный пункт, который стоит поправить сразу.

Асинхронность для удалённого AIE сделана самописным менеджером операций: `aie_start_scan` возвращает
`operation_id`, затем `aie_get_operation` и `aie_cancel_operation`. В ответе есть `state`, `stage`,
`effects`, `poll_after_ms: 3000` и явное `persistence: 'current_process_only'`, а ещё лимит 4 активных
операции, идемпотентность по цели скана и TTL 24 часа. Всё хранится в `Map` в памяти процесса, и после
рестарта клиент получает `OperationNotFound`. Это ровно вариант 1 из нашего эксперимента B — и хорошо,
что состояние названо честно.

Локальный режим проксируется синхронно с таймаутом 30 минут, а ожидание организовано подсказкой в
описании инструмента («follow the wait instruction»), то есть поллингом на уровне промпта.

Вывод: идея операции в форме Tasks там уже есть, не хватает внешнего хранилища, долгого ожидания
внутри статуса и протокольного адаптера.

## 10. Что в прод, а что нет

| Решение | Вердикт | Почему |
|---|---|---|
| Stateless-ядро 2026-07-28 в dual-era режиме | в прод | зонды 1–6 прошли, старые клиенты не ломаются |
| Валидация `Mcp-Method`/`Mcp-Name` на сервере и шлюзе | в прод | SDK возвращает `-32020`, зонды 3–4, 8–10 |
| Миграция с roots, sampling, logging | в план | deprecated, окно 12 месяцев; ветка TS v1.x поддерживается минимум 6 месяцев после 27 июля |
| Нативные Tasks на C# и Rust | с оговорками | рантайм есть, но воркер по умолчанию в том же процессе; нужны постоянное хранилище и внешняя очередь |
| Нативные Tasks на TypeScript и Python | не в прод | серверного рантайма нет: идентификатор расширения в пакетах 2.4.0 и 2.3.0 не встречается |
| Расчёт на то, что клиент сам поллит `tasks/get` | не в прод | массовые клиенты расширение не объявляют, кроме беты Claude Code CLI |
| Гибрид: инструменты + запись в форме Tasks + адаптер позже | в прод | работает везде, эксперимент A |
| Ожидание внутри вызова дольше 35–40 с | не в прод | дефолт таймаута SDK 60 с и сообщения о 60 с у клиентов |
| Операции в памяти процесса | не в прод | эксперимент B, вариант 1 |
| Внешнее хранилище без heartbeat | не в прод | эксперимент B, вариант 2 — худший |
| Внешний воркер + lease + идемпотентность | в прод, если есть очередь | эксперимент B, варианты 4–5 |
| MCP Events и вебхуки OpenAI | наблюдать | черновик, нет эталонной реализации |

## 11. Что мы не смогли подтвердить

В обзорах и черновиках вокруг темы встречаются утверждения, которые мы не проверили, поэтому в
статью они не вошли:

- «production-телеметрия» с 45-секундным бюджетом и 22 вызовами дольше 60 секунд из обсуждения
  python-sdk#2806: issue не открывался (rate limit GitHub API), цифры нигде не подтверждены;
- «конфликт `pollIntervalMs` и окна очистки осиротевших задач (§6.4)» в работе «Stateless Protocol,
  Stateful Problem»: в тексте спецификации Tasks слова «orphan» нет (проверено grep по SEP-2663),
  источник не найден;
- точные таймауты коннекторов claude.ai (около 240 и 311 секунд): цифр в проверенных материалах нет;
- поведение адаптеров LangChain и GigaChain с Tasks;
- матрица клиентов на 28 октября: это пересказ в стороннем блоге, официальную страницу мы не
  открывали. Версия TS SDK в одном из черновиков указана как 2.3.x, фактически на 20 ноября это 2.4.0.

Если у вас есть замеры на реальных клиентах, пишите в комментариях: эти строки таблицы можно будет
заменить фактами.

## 12. Как воспроизвести

```
experiments/
  README.md           # как запускать прогоны
  RESULTS.md          # сводка измерений и аудита
  versions.json       # все версии окружения
  run-all.ps1         # прогнать всё сразу
  package.json        # версии SDK зафиксированы
  exp0_probe/         # node probe.mjs
  expA_polling/       # node run.mjs
  expB_crash/         # node run.mjs
  expC_go/            # go run .
  expD_csharp/        # dotnet run (Server + Client)
  expE_rust/          # cargo run по тегу rmcp-v3.11.0
  expF_java/          # mvn compile + java expf.Client
```

`exp0_probe` поднимает сервер на 13 зондов и пишет `results.json`. `expA_polling` делает 45 прогонов
(3 задачи × 3 режима × 5 повторов) и пишет медианы. `expB_crash` убивает процессы через `taskkill /F`
и проверяет шесть вариантов хранилища и воркера, сводка — `results-all.json`. `expC_go` и
`expD_csharp` — настоящие клиент и сервер по stdio: в Go задачи отсутствуют как API, в C# двенадцать
из двенадцати вызовов создали задачу. `expE_rust` запускает примеры `rmcp` 3.11.0. `expF_java`
собирает клиент и сервер на Java SDK 2.2.0 и проверяет отсутствие Tasks в jar’ах. Время и версии —
в `experiments/RESULTS.md`.

Всё сразу: `powershell -ExecutionPolicy Bypass -File experiments\run-all.ps1`. Карта
«утверждение → файл с доказательством» — в `ARTIFACTS.md`.

## Источники

- Релиз спецификации 2026-07-28: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Release candidate и таймлайн: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- Спецификация и changelog: https://github.com/modelcontextprotocol/modelcontextprotocol
- Расширение Tasks и SEP-2663: https://github.com/modelcontextprotocol/ext-tasks
- ROADMAP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md
- ROADMAP Python SDK: https://github.com/modelcontextprotocol/python-sdk/blob/main/ROADMAP.md
- Tasks в C# SDK: https://csharp.sdk.modelcontextprotocol.io/v2/concepts/tasks/tasks.html
- Rust SDK и Tasks: https://github.com/modelcontextprotocol/rust-sdk
- Java SDK 2.2.0: https://github.com/modelcontextprotocol/java-sdk/releases/tag/v2.2.0
- Google Developers Blog про stateless: https://developers.googleblog.com/scaling-ai-agent-infrastructure-with-the-mcp-stateless-updates/
- Upstash, Tasks и Events: https://upstash.com/blog/mcp-tasks-and-events
- Upstash, Tasks в Claude Code: https://upstash.com/blog/claude-code-mcp-tasks
- Upstash, Upsy и Tasks: https://upstash.com/blog/upsy-mcp-tasks
- Tasks в Claude Code, разбор wire-различий: https://dev.to/gabrielanhaia/claude-code-now-runs-mcp-tasks-in-the-background-how-mcp-tasks-actually-work-4ka1
- Feature request в Claude Code: https://github.com/anthropics/claude-code/issues/102347
- Таймауты и `resetTimeoutOnProgress`: https://github.com/modelcontextprotocol/python-sdk/issues/1374
- `ptai-mcp`: https://github.com/POSIdev-community/ptai-mcp

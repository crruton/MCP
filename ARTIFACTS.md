# Карта артефактов: утверждение → файл

Каждое числовое или фактическое утверждение статьи можно проверить по конкретному файлу.
Пути — относительно корня репозитория.

## Эксперимент 0: 13 HTTP-зондов

| Утверждение | Где доказательство |
|---|---|
| `supportedVersions: ["2026-07-28"]`, `ttlMs: 0`, `cacheScope: "private"` | `experiments/exp0_probe/results.json` → `01_discover_with_tasks_declared` |
| `resultType: "complete"` на обычном вызове | `experiments/exp0_probe/results.json` → `02_tools_call_ok` |
| `-32020` при расхождении `Mcp-Name` | `experiments/exp0_probe/results.json` → `03_mcp_name_mismatch` |
| `-32020` при расхождении `Mcp-Method` | `experiments/exp0_probe/results.json` → `04_mcp_method_mismatch` |
| `-32022` с `data.supported` / `data.requested` | `experiments/exp0_probe/results.json` → `05_unsupported_version` |
| Legacy `initialize` 2025-11-25 отдаётся по SSE | `experiments/exp0_probe/results.json` → `06_legacy_initialize` |
| Stateless-fallback обслуживает следующий legacy-запрос | `experiments/exp0_probe/results.json` → `06b_legacy_tools_call` |
| `tasks/get` на сервере без Tasks → `404 / -32601` | `experiments/exp0_probe/results.json` → `07_tasks_get_no_tasks` |
| Отсутствие `Mcp-Method` → `-32020` | `experiments/exp0_probe/results.json` → `08_missing_mcp_method` |
| Отсутствие `Mcp-Name` → `-32020` | `experiments/exp0_probe/results.json` → `09_missing_mcp_name` |
| Версия сверяется между заголовком и `_meta` | `experiments/exp0_probe/results.json` → `10_header_meta_version_mismatch` |
| `tasks/list` → `404 / -32601` | `experiments/exp0_probe/results.json` → `11_unknown_method` |
| Инструмент на 1 с отвечает синхронно | `experiments/exp0_probe/results.json` → `12_slow_tool_1s` |

## Эксперимент A: ходы модели и long-poll

| Утверждение | Где доказательство |
|---|---|
| 4 / 16 / 63 хода в режиме `poll` | `experiments/expA_polling/results.json` → `table[].turnsPoll` |
| 2 / 3 / 8 ходов в режиме `longpoll` | `experiments/expA_polling/results.json` → `table[].turnsLong` |
| Выигрыш 2,0× / 5,3× / 7,9× | `experiments/expA_polling/results.json` → `table[].speedupFair` |
| Время до результата 704/624, 4270/4101, 18 368/18 124 мс | `experiments/expA_polling/results.json` → `table[].elapsed*` |
| Разброс по повторам (3–4, 14–16, 62–63) | `experiments/expA_polling/results.json` → `runs[].turns.all` |
| Объём tool-результатов 13 370 Б против 1 655 Б на 180-секундной задаче | `experiments/expA_polling/results.json` → `runs[].resultBytes.median` |
| Оценка O(N²) и ~428 КБ против ~7,4 КБ | расчёт из `resultBytes.median` и `turns.median`, формула в `experiments/RESULTS.md`, раздел 2 |

## Эксперимент B: падение процесса

| Утверждение | Где доказательство |
|---|---|
| B1: задача пропала, `unknown` 3/3 | `experiments/expB_crash/results-all.json` → `B1-memory` |
| B2: `working` 3/3, эффект 1, воркера нет | тот же файл → `B2-file` |
| B3: `failed`, «worker lost (stale heartbeat)» 3/3 | тот же файл → `B3-file-heartbeat` |
| B4: `completed` 2/2 после рестарта | тот же файл → `B4-external-worker` |
| B5: recovery + идемпотентность, эффект 1 | тот же файл → `B5-recover-idempotent` |
| B6: recovery без идемпотентности, эффект 2 | тот же файл → `B6-recover-no-idempotency` |
| Число поллингов и время до терминального статуса | тот же файл → `rows[].polls`, `rows[].waitedMs` |
| Лог прогона: `BOOT_SCAN`, `ORPHAN`, `REDISPATCHED`, тайминги | `experiments/expB_crash/run.log` |

Файлы `results-B1-memory.json`, `results-B6-recover-no-idempotency.json` и
`results-B1-memory_B2-file_B3-file-heartbeat_B4-external-worker_B5-recover-idempotent.json` —
остатки частичных прогонов до правки гонок; канонический результат — `results-all.json`.

## Аудит SDK и живые прогоны

| Утверждение | Где доказательство |
|---|---|
| TS 2.4.0: ядро есть, серверного рантайма Tasks нет | `experiments/package.json` (версии) + grep по `node_modules/@modelcontextprotocol/server/dist` |
| Python 2.3.0: `MethodBinding` есть, Tasks нет | wheel `mcp` 2.3.0 + grep по `io.modelcontextprotocol/tasks` |
| Go 1.8.0: согласован `2026-07-28`, `echo`, `isError=false`, Tasks нет | `experiments/expC_go/results.json`, лог `experiments/expC_go/run.log` |
| C# 2.4.0: 12/12 задач, поллинг 2118 мс, обычный вызов 1525,5 мс | `experiments/expD_csharp/results.json` |
| C#: `pollIntervalMs=1000`, `status=Working` | `experiments/expD_csharp/results.json` → `rows[]` |
| Rust 3.11.0: `slow_sum` стал задачей, статусы `Working → Completed`, результат `42` | `experiments/expE_rust/results.json`, лог `experiments/expE_rust/run.log` |
| Rust: согласована версия `2025-11-25`, расширение `io.modelcontextprotocol/tasks` | `experiments/expE_rust/run.log` (строки `Service initialized as client/server`) |
| Java 2.2.0: ядро `2026-07-28` работает, Tasks нет | `experiments/expF_java/results.json`, лог `experiments/expF_java/run.log` |
| Java: 0 вхождений `io.modelcontextprotocol/tasks`, `CreateTaskResult`, `TaskManager`, `TaskStore` в трёх jar’ах | `experiments/expF_java/results.json` → `tasksEvidence` |

## Версии окружения

| Утверждение | Где доказательство |
|---|---|
| Node 24.20.0, TS SDK 2.4.0, `@modelcontextprotocol/node` 2.1.2, zod 4.6.7 | `experiments/versions.json`, `experiments/package.json`, `experiments/package-lock.json` |
| Go 1.27.4, `go-sdk` 1.8.0 | `experiments/versions.json`, `experiments/expC_go/go.mod` |
| .NET SDK 10.0.404, runtime 10.0.15 | `experiments/versions.json`, `experiments/expD_csharp/results.json` |
| Rust 1.100.0, `rmcp` 3.11.0, GNU target | `experiments/versions.json`, `experiments/expE_rust/results.json` |
| JDK 21.0.13.1, Maven 3.10.2, Java SDK 2.2.0 | `experiments/versions.json`, `experiments/expF_java/results.json` |

## Что НЕ подтверждено файлами

Эти утверждения в статье помечены как вторичные источники, файлов с замерами у них нет:

- таймауты и поддержка Tasks в клиентах (Claude Code, ChatGPT, Cursor, claude.ai, Claude Desktop, VS Code);
- «production-телеметрия» из python-sdk#2806;
- «конфликт `pollIntervalMs` и окна очистки осиротевших задач»;
- точные таймауты коннекторов claude.ai;
- поведение адаптеров LangChain и GigaChain.

Список источников — в конце `article/habr.md`.

# Эксперименты к статье про MCP Tasks

Здесь лежат все прогоны, на которые ссылается статья. Ничего не имитировано: серверы поднимаются
по-настоящему, падения процессов — это `taskkill /F`, результаты пишутся в JSON рядом со скриптами.

## Окружение

| Что | Значение |
|---|---|
| ОС | Windows 11 |
| Node.js | 24.20.0 |
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/node` | 2.1.2 |
| `zod` | 4.6.7 (из `node_modules`, в `package.json` стоит `^4.1.0`) |
| Go | 1.27.4, `go-sdk` 1.8.0 |
| .NET | SDK 10.0.404, runtime 10.0.15 |
| Rust | 1.100.0, `rmcp` 3.11.0, target `x86_64-pc-windows-gnu` |
| MinGW | winlibs GCC 16.2.0 (линкер для Rust) |
| Java | Temurin JDK 21.0.13.1, Maven 3.10.2, `io.modelcontextprotocol.sdk:mcp` 2.2.0 |

Версии SDK зафиксированы в `package.json`, `expC_go/go.mod`, `expD_csharp/*/*.csproj`, `expF_java/pom.xml`
и теге `rmcp-v3.11.0`. Сводка версий — `versions.json`.

## Установка

```powershell
cd experiments
npm install
```

Если `npm install` в вашем окружении очень медленный на пакетах `@modelcontextprotocol/*`,
поставьте их напрямую из tarball’ов npm registry (`npm pack` в пустой папке, затем
`npm install <file>.tgz`). Именно так ставились 2.4.0 и 2.1.2 в исходной песочнице.

## Прогоны

Все команды выполняются из `experiments/`. Все прогоны сразу:

```powershell
powershell -ExecutionPolicy Bypass -File run-all.ps1
```

Логи складываются в `logs/`. Отдельные эксперименты: `-Only exp0,expA`. Для `expF` нужны
`JAVA_HOME` и `MAVEN_HOME`, для `expE` — `RUST_SDK_DIR` с чекаутом `rust-sdk` на теге `rmcp-v3.11.0`.

### 0. Зонды ядра (13 запросов)

```powershell
node exp0_probe\probe.mjs
```

- `exp0_probe\server.mjs` — минимальный сервер на TS SDK v2 с инструментами `echo` и `slow_echo`,
  без расширения Tasks.
- `probe.mjs` сам поднимает сервер на `127.0.0.1:3100` (переопределяется через `PORT`), отправляет
  13 запросов и пишет `exp0_probe\results.json`.

Что проверяется: `server/discover`, зеркалирование `Mcp-Method`/`Mcp-Name`, коды `-32020`/`-32022`,
legacy `initialize` 2025-11-25, `tasks/get` и `tasks/list` на сервере без Tasks, ответ на медленный
инструмент. Ожидаемые статусы и коды — в таблице раздела 1 `RESULTS.md`.

Лог последнего прогона: `exp0_probe\run.log`.

### A. Сколько ходов съедает поллинг

```powershell
node expA_polling\run.mjs
```

- `expA_polling\server.mjs` — инструменты `start_job`, `get_job_status(taskId, waitMs)` и
  `cancel_job`.
- `run.mjs` имитирует модель: один ход = один вызов инструмента. Пишет `expA_polling\results.json`.

Параметры (по умолчанию совпадают с прогоном в статье):

| Переменная | По умолчанию | Смысл |
|---|---:|---|
| `PORT` | `3110` | порт сервера |
| `REPEATS` | `5` | повторов на ячейку |
| `TURN_DELAY_MS` | `300` | пауза между ходами «модели» |

`run.mjs` содержит три режима и три длительности, всего 3 × 3 × 5 = **45 прогонов**:

| Режим | Что делает |
|---|---|
| `poll` | `get_job_status(waitMs=0)` и пауза между ходами |
| `longpoll` | `get_job_status(waitMs=2500)` и та же пауза (честное сравнение) |
| `longpoll-burst` | `waitMs=2500` без паузы (нижняя граница) |

Задачи ускорены в 10 раз: 0,5 / 4 / 18 с вместо 5 / 40 / 180 с, бюджет ожидания 2,5 с вместо 25 с.
В `results.json` на ячейку лежат медианы `turns` и `resultBytes`; производные числа (выигрыш, оценка
O(N²)) считаются в `RESULTS.md`.

Лог: `expA_polling\run.log`.

### B. Падение процесса

```powershell
node expB_crash\run.mjs
```

- `expB_crash\server.mjs` — MCP-сервер с режимами хранилища (`STORE=memory|file|file-heartbeat|
  external|recover`), `worker.mjs` — внешний воркер, `store.mjs` — файловое хранилище.
- `run.mjs` запускает сервер, стартует задачу на 30 с, убивает процесс через `taskkill /F`,
  поднимает сервер заново и поллит статус до терминального состояния. Пишет `results-<ONLY|all>.json`.

Сценарии: B1 память, B2 файл, B3 файл + heartbeat, B4 внешний воркер, B5 recovery + идемпотентность,
B6 recovery без идемпотентности. Параметры по умолчанию: убийство на 3 с (побочный эффект наступает
на 2-й секунде), ожидание терминального статуса до 10 с; для B5–B6 — убийство на 5 с вместе с воркером,
ожидание до 45 с.

Отдельный сценарий можно прогнать так:

```powershell
$env:ONLY = "B1-memory"
node expB_crash\run.mjs
```

`ONLY` принимает список через запятую; пробелы вокруг имён обрезаются, а неизвестное имя теперь
даёт ошибку с перечнем доступных сценариев, а не пустой файл результатов. Остальные переменные:
`STALE_MS` (порог heartbeat, по умолчанию 1000), `IDEMPOTENT=0` для отключения идемпотентности.

В cmd не пишите `set ONLY=B1-memory && node run.mjs`: пробел перед `&&` попадёт в значение.
Используйте `set "ONLY=B1-memory" && node run.mjs` или PowerShell, как в примере выше.

Файлы результатов:

| Файл | Что внутри |
|---|---|
| `results-all.json` | **канонический прогон**: B1–B6, все шесть сценариев |
| `results-B1-memory_B2-file_B3-file-heartbeat_B4-external-worker_B5-recover-idempotent.json` | частичный прогон B1–B5 до правки гонок |
| `results-B1-memory.json` | повторный прогон B1 после правки парсера ответа (совпадает с `results-all.json`) |
| `results-B6-recover-no-idempotency.json`, `results.json` | B6 отдельным запуском (ранний формат имени файла) |

Частичные файлы оставлены как история; числа в статье и `RESULTS.md` сверены с `results-all.json`.
В нём у каждой строки есть `polls` и `waitedMs` — сколько поллингов и миллисекунд понадобилось,
чтобы дойти до терминального статуса (или до таймаута). Полный прогон всегда пишется в
`results-all.json`, частичный — в `results-<сценарии>.json`.

### C. Go: клиент и сервер по stdio

```powershell
cd expC_go
go run .
```

`main.go` — один бинарник: без аргументов он клиент, с `-server` — сервер. Клиент запускает себя
же через `CommandTransport`, печатает согласованную версию, `tools/list` и результат `tools/call`.
Лог — `run.log`, сводка — `results.json`. Версия SDK — `go-sdk` 1.8.0.

Ожидаемый результат: `protocolVersion: "2026-07-28"`, инструмент `echo`, `isError=false`.
API задач в пакете нет — это и есть вывод эксперимента.

### D. C#: настоящие Tasks

```powershell
cd expD_csharp
dotnet build Server\Server.csproj
dotnet build Client\Client.csproj
$env:DOTNET_HOST_PATH = (Get-Command dotnet).Source
dotnet Client\bin\Debug\net10.0\Client.dll Server\bin\Debug\net10.0\Server.dll
```

Сервер: `WithTasks(new InMemoryMcpTaskStore())`, инструмент `slow_echo` спит 1500 мс. Клиент:
`CallToolAsTaskAsync` (ожидает `CreateTaskResult`), затем `CallToolWithPollingAsync` (полный цикл),
затем обычный `CallToolAsync` без opt-in. Лог — `run.log`, сводка — `results.json`.

Ожидаемый результат: версия `2026-07-28`, `isTask=True`, `pollIntervalMs=1000`, поллинг около
2,1 с, обычный вызов около 1,5 с.

Если `Client.dll` не находится, запускайте из папки `expD_csharp` и передавайте пути к DLL
относительно неё; `DOTNET_HOST_PATH` нужен клиенту, чтобы поднять сервер тем же `dotnet`.

### E. Rust: примеры `rmcp` с Tasks

```powershell
git clone --branch rmcp-v3.11.0 --depth 1 https://github.com/modelcontextprotocol/rust-sdk
cd rust-sdk
cargo run -p mcp-client-examples --example clients_task_stdio
```

Клиент сам запускает сервер `examples/servers/src/task_stdio.rs` через `cargo run`. Нужны
`cargo`, GNU-линкер (MinGW) и терпение: первая сборка зависимостей заняла у нас около 46 минут
(362 крейта). Лог — `run.log` в `expE_rust`, сводка — `results.json`.

Ожидаемый результат: `quick_echo` отвечает синхронно, `slow_sum` возвращает `CreateTaskResult`,
клиент поллит `tasks/get` и получает `completed` с результатом внутри задачи. Согласованная
версия — `2025-11-25`: примеры `rmcp` ещё не перешли на `2026-07-28`.

### F. Java: клиент и сервер по stdio

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.13.10002-hotspot"
$env:MAVEN_HOME = "C:\apache-maven-3.10.2"
powershell -ExecutionPolicy Bypass -File expF_java\run.ps1
```

`src/main/java/expf/Server.java` — минимальный сервер 2026-07-28 с инструментом `echo`,
`Client.java` — клиент, который делает `discover()`, `tools/list` и `tools/call` по stdio.
Лог — `expF_java/run.log`, сводка — `expF_java/results.json`.

Ожидаемый результат: `supportedVersions: ["2026-07-28"]`, `extensions: null`, `tool=echo`,
`isError=null`. Tasks в 2.2.0 нет — это и есть вывод эксперимента (0 вхождений extension id
в трёх jar’ах, см. `results.json` → `tasksEvidence`).

JDK и Maven можно поставить так:

```powershell
winget install --id EclipseAdoptium.Temurin.21.JDK --accept-package-agreements --accept-source-agreements
curl -L -o "$env:TEMP\maven.zip" https://dlcdn.apache.org/maven/maven-3/3.10.2/binaries/apache-maven-3.10.2-bin.zip
tar -xf "$env:TEMP\maven.zip" -C C:\
```

## Оговорки

- На Windows с антивирусом старт и `taskkill` занимают секунды. В логах heartbeat «протухает»
  примерно на 10 с вместо 1 с. На выводы это не влияет: проверяется факт обнаружения потерянного
  воркера, а не точность таймера.
- «Модель» в эксперименте A — детерминированный цикл вызовов, а не LLM. Считаются вызовы и байты
  tool-результатов, не токены и не деньги.
- Java запущена живьём (JDK 21 + Maven 3.10.2), но проверять там можно только modern-ядро:
  расширения Tasks в 2.2.0 нет. Go, C#, Rust и Java — настоящие прогоны, см. разделы C–F
  и `RESULTS.md`.
- Клиенты (Claude Code, ChatGPT, Cursor и т. д.) не тестировались. Все утверждения о них —
  вторичные источники, перечисленные в статье.

## Что читать дальше

- `RESULTS.md` — сводка всех измерений и аудита SDK с точными цифрами.
- `../ARTIFACTS.md` — карта «утверждение статьи → файл с доказательством».
- `../article/habr.md` — готовая статья.
- `../article/habr-meta.md` — заголовок, хабы, теги и чек-лист публикации.

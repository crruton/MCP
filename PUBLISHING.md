# Как опубликовать

Репозиторий инициализирован, первый коммит сделан в ветке `main`. Remote пока не настроен.

## 1. Проверить, что попадёт в коммит

Первый коммит уже сделан (`312d5e9`, ветка `main`). Для следующих изменений:

```powershell
git add -A --dry-run
```

В индекс должны попасть только исходники, статья, логи прогонов и `results*.json`.
Не должны: `node_modules/`, `experiments/expF_java/target/`, `experiments/expD_csharp/**/bin|obj/`,
`experiments/logs/`, `experiments/expF_java/build.log`, `*.tmp`.

## 2. Коммиты

Первый коммит: `312d5e9` «MCP Tasks, ноябрь 2026: статья, эксперименты и замеры», 56 файлов.
Для следующих коммитов:

```powershell
git add -A
git commit -m "<что изменилось>"
```

## 3. Репозиторий на GitHub

Ветка уже переименована в `main`. Осталось создать пустой репозиторий на github.com и выполнить:

```powershell
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

Перед публикацией стоит решить два вопроса:

- **Лицензия.** В `LICENSE` стоит MIT для кода и CC BY 4.0 для текста статьи. Если нужна другая
  (например, Apache-2.0 или CC BY-SA), замените файл целиком.
- **Авторство.** В `CITATION.cff` и `LICENSE` уже вписан автор (Aleksandr Nosov). Если нужно —
  добавьте `orcid` и `affiliation`.

## 4. Что проверить после публикации

- CI (`.github/workflows/experiments.yml`) зелёный: Node-эксперименты на Windows, Go, Java и .NET.
  Rust в CI не гоняется — первая сборка занимает ~46 минут, это дороже лимита.
- Ссылки в статье открываются: список в конце `article/habr.md`.
- `ARTIFACTS.md` не разошёлся с файлами: после любого нового прогона обновите таблицы.

## 5. Публикация статьи на Habr

1. Открыть `article/habr-meta.md` — там заголовок, хабы, теги и чек-лист.
2. В редакторе Habr вставить `article/habr.md` в режиме Markdown.
3. `<cut>` в тексте — это маркер места для кнопки «Читать далее»; в редакторе Habr поставить
   кат в том же месте вручную.
4. Загрузить `article/cover.png` как обложку.
5. В конце статьи — ссылка на этот репозиторий.

## 6. Если данные обновятся

Прогоны детерминированы по структуре, но не по времени. После повторного запуска:

```powershell
powershell -ExecutionPolicy Bypass -File experiments\run-all.ps1
```

обновите числа в `experiments/RESULTS.md`, `article/habr.md` и таблицы в `ARTIFACTS.md`.
Расхождения в пределах ±5 % по времени — норма (Windows, антивирус, холодный старт).

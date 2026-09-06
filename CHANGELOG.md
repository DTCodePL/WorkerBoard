# Changelog

All notable changes to Worker Board are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Wszystkie istotne zmiany w Worker Board są opisane poniżej — najpierw po angielsku,
pod każdą wersją po polsku.

## [0.6.1] - 2026-09-06

### Added

- `CHANGELOG.md`, shown as a separate tab on the Marketplace page.

**Dodane** — `CHANGELOG.md`, widoczny jako osobna zakładka na stronie w Marketplace.

## [0.6.0] - 2026-09-06

### Changed

- Nesting is now readable: indentation doubled to 16 px per level, the guide line
  is thicker and uses the foreground colour, and a child block is separated from
  neighbouring rows. With two conversations side by side it was previously
  impossible to tell which subtask belonged to which task.
- A conversation with at least one running descendant now shows `w toku`
  (in progress) instead of `bezczynna` (idle) or `czeka` (waiting), is no longer
  dimmed, and its timer ticks from the start of the earliest running descendant —
  answering "how long has this task been running", not "how long is the current turn".
- Documentation is bilingual: `README.md` carries a full English half and a full
  Polish half with a language switcher.
- The Marketplace description is given in both English and Polish.

### Removed

- Client project names and personal paths were removed from the public repository
  and from the deployed wrapper and skill.

**Zmienione** — czytelne zagnieżdżenie (wcięcie 16 px, wyraźniejsza linia prowadząca,
odstęp wokół bloku dzieci); konwersacja z pracującym potomkiem pokazuje `w toku`
zamiast `bezczynna`/`czeka`, nie jest wygaszona, a jej licznik liczy od startu
najwcześniejszego pracującego potomka; dokumentacja i opis w sklepie po polsku
i angielsku. **Usunięte** — nazwy projektów klienckich i ścieżki osobowe
z publicznego repozytorium oraz z wdrażanego wrappera i skilla.

## [0.5.1] - 2026-09-06

### Added

- Tasks are grouped by conversation instead of by engine. A Claude Code session is
  the root, and everything it spawned hangs beneath it regardless of engine —
  Claude subagents plus Spark and Codex workers. Workers are attributed through a
  `sessionId` field the wrapper fills in automatically from `CLAUDE_CODE_SESSION_ID`.
- A `BEZ PRZYPISANIA` (unattributed) group for workers that cannot be tied to any
  visible conversation.
- A conversation stays visible while it has a visible child, so dispatching workers
  no longer collapses the whole group.
- Marketplace metadata: PNG icon, MIT licence, repository, keywords and gallery banner.
- `PUBLISHING.md` with the full publishing procedure.

### Fixed

- A session is reported as running only on positive evidence — a tool call still
  executing, or an open turn with the transcript being written. The state
  "you sent a message and nothing has been produced yet" is deliberately hidden,
  because a file cannot distinguish a thinking model from a queued message.
- A resumed subagent is no longer treated as finished. Each resumption appends
  another completion notification, so completion is now decided by comparing the
  transcript's modification time against the latest notification.
- A single unreadable file no longer aborts the whole scan.
- A heartbeat record with an unrecognised status is never deleted by
  "remove finished records" — previously an unclassifiable record was treated as
  failed and removed.
- Records missing required fields are skipped instead of reaching the webview.
- The file cache releases entries that were not requested during a scan.

**Dodane** — grupowanie po konwersacji zamiast po silniku, z atrybucją workerów przez
pole `sessionId` wypełniane automatycznie; grupa `BEZ PRZYPISANIA`; rodzic pozostaje
widoczny, dopóki ma widoczne dziecko; metadane do Marketplace i `PUBLISHING.md`.
**Naprawione** — sesja raportowana jako pracująca wyłącznie na dowodzie pozytywnym;
wznowiony subagent nie jest już uznawany za zakończony; pojedynczy nieczytelny plik
nie przerywa skanowania; rekord o nieznanym statusie nie jest kasowany; rekordy bez
wymaganych pól są pomijane; cache zwalnia nieużywane wpisy.

## [0.1.0] - 2026-09-06

### Added

- First working panel: a sidebar view listing AI tasks that are running right now —
  Claude Code sessions and subagents read from transcripts, plus Spark and Codex
  workers read from heartbeat records written by `worker-run.ps1`.
- Per-row metrics: model, effort, repository, branch, current tool, token usage and
  context fill.
- `install.ps1`, which checks prerequisites, builds and installs the extension, and
  deploys the wrapper and the `external-workers` skill into `~/.claude/`.

**Dodane** — pierwszy działający panel z zadaniami wykonywanymi w danej chwili,
metrykami w wierszu oraz instalator wdrażający wrapper i skill.

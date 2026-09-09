# Changelog

All notable changes to Worker Board are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

Wszystkie istotne zmiany w Worker Board są opisane poniżej — najpierw po angielsku,
pod każdą wersją po polsku.

## [0.8.1] - 2026-09-09

### Fixed

- A session with no `ai-title` yet no longer falls back to the raw project
  directory slug (`d--projects-DTCode-…`). It now shows the start of the
  first real user message, matching what the Claude Code tab displays —
  including slash commands, taken from the `<command-name>` wrapper rather
  than the first line, because the first line is markup.

### Changed

- `worker-run.ps1` gained `-Mode review`, so `codex exec review` runs through
  the wrapper and therefore appears in the panel. Pre-push reviews were
  previously invisible by design, which is exactly when you most want to know
  whether one is still running. Without a brief the wrapper adds
  `--uncommitted`, since the CLI has no default scope.
- The wrapper's PowerShell 7 requirement is now documented instead of implied:
  measured on 2026-09-09, the same Codex call fails under Windows PowerShell
  5.1 with `stdin is not a terminal` and succeeds under `pwsh` 7. The
  installer itself still runs on 5.1.

**Naprawione** — sesja bez `ai-title` nie pokazuje już sluga katalogu, tylko
początek pierwszej prawdziwej wiadomości użytkownika (komendy ukośnikowe
czytane ze znacznika `<command-name>`, bo pierwsza linia to znacznik).
**Zmienione** — `worker-run.ps1` ma tryb `-Mode review`, więc przegląd kodu
Codexa jest widoczny w panelu; bez briefu wrapper dokłada `--uncommitted`.
Wymóg PowerShell 7 dla wrappera jest teraz udokumentowany i zmierzony —
instalator nadal działa na 5.1.

## [0.8.0] - 2026-09-08

### Added

- Clicking a row opens the corresponding Claude Code conversation. Rows for
  sessions, subagents and workers all lead to the **parent conversation**,
  since a subagent has no tab of its own. Workers with no attribution stay
  unclickable. This relies on `claude-vscode.editor.open`, an internal command
  of the Claude Code extension (verified against 2.1.263); if it ever
  disappears the panel degrades to a warning instead of breaking.

**Dodane** — kliknięcie wiersza otwiera odpowiadającą mu rozmowę Claude Code;
sesja, subagent i worker prowadzą do konwersacji rodzica. Opiera się na
wewnętrznej komendzie rozszerzenia Claude Code, więc jej zniknięcie degraduje
się do ostrzeżenia, a nie do awarii panelu.

## [0.7.1] - 2026-09-06

### Changed

- The `Requirements`/`Installation` sections now split into the two levels
  the extension actually has: Level 1 (Marketplace install, `code
  --install-extension dtcode.worker-board`) needs only VS Code and shows
  Claude Code sessions/subagents with zero further setup; Level 2 (Spark
  and Codex workers) needs the `worker-run.ps1` wrapper, and is now
  documented with two ways to get it — the source-build installer, or a
  manual two-file copy that keeps the Marketplace build and needs no
  Node.js. Node.js/npm/`@vscode/vsce` are now labelled as build-from-source
  only, no longer implied as required to install or run the extension.
  The literal `git clone <this-repository-url>` placeholder was replaced
  with the real repository URL.

**Zmienione** — sekcje `Wymagania`/`Instalacja` dzielą się teraz na dwa
realnie istniejące poziomy: Poziom 1 (instalacja ze sklepu, `code
--install-extension dtcode.worker-board`) potrzebuje tylko VS Code i od
razu pokazuje sesje/subagentów Claude Code bez żadnej dodatkowej
konfiguracji; Poziom 2 (workery Spark i Codex) wymaga wrappera
`worker-run.ps1` i jest teraz opisany dwiema drogami — instalatorem
budującym ze źródeł albo ręcznym skopiowaniem dwóch plików, które
zachowuje wersję ze sklepu i nie wymaga Node.js. Node.js/npm/`@vscode/vsce`
są teraz oznaczone jako potrzebne wyłącznie do budowy ze źródeł, a nie
sugerowane jako wymagane do instalacji czy uruchomienia rozszerzenia.
Zastąpiono też literalny placeholder `git clone <adres-tego-repozytorium>`
prawdziwym adresem repozytorium.

## [0.7.0] - 2026-09-06

### Fixed

- `install.ps1` now runs on the Windows PowerShell 5.1 that ships with every
  Windows install — no syntax in the script actually required PowerShell 7,
  so the version floor was lowered instead of adding a wrapper.
- The VS Code CLI check no longer fails when `code`/`code-insiders` is
  installed but not added to PATH (not the default on the Windows
  installer): the installer now also looks in the standard per-user and
  per-machine install locations before reporting the requirement as missing,
  and uses the resolved path for the later install/uninstall calls.
- The WSL/Spark check now matches any `Ubuntu*` distribution (e.g.
  `Ubuntu-22.04`, `Ubuntu-24.04`), not only a distribution named exactly
  `Ubuntu`, and reports the matched name.
- The wrapper/skill backup filename now includes milliseconds and the
  process ID, so two installer runs within the same second no longer
  overwrite each other's backup.
- `--uninstall-extension` no longer silently swallows every error: "not
  installed" stays silent (expected on a first install), anything else is
  printed as a warning without aborting the installation.
- The "remove finished records" confirmation now states what it actually
  removes: finished **and interrupted** worker records, the latter being
  records left as running by a process that is no longer alive.

**Naprawione** — `install.ps1` działa teraz na Windows PowerShell 5.1 (nic w
skrypcie nie wymagało realnie PowerShell 7, więc obniżono próg wersji);
wykrywanie CLI VS Code sprawdza też standardowe lokalizacje instalacji, gdy
`code`/`code-insiders` nie jest w PATH; dopasowanie dystrybucji WSL działa
prefiksowo (`Ubuntu*`), nie tylko dla nazwy dokładnie `Ubuntu`; nazwa kopii
zapasowej ma teraz milisekundy i PID, więc dwa przebiegi w tej samej sekundzie
nie nadpisują się nawzajem; błędy `--uninstall-extension` inne niż "brak
zainstalowanej wersji" są wypisywane jako ostrzeżenie zamiast być cicho
połykane.

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

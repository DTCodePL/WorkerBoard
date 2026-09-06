# Worker Board

A VS Code side-panel extension showing every AI task running right now, in one place: Claude Code sessions and subagents, plus external Spark (`muse`) and Codex workers.
Rozszerzenie VS Code z panelem w pasku bocznym, pokazującym w jednym miejscu wszystkie zadania AI wykonywane w tej chwili: sesje i subagentów Claude Code oraz workery zewnętrzne Spark (`muse`) i Codex.

**English** | [Polski](#polski)

The extension is free and available on the Visual Studio Marketplace:
`code --install-extension dtcode.worker-board`.

## What it is

A VS Code extension with a side-panel showing, in one place, every AI task
running **right now**: Claude Code sessions and subagents, and the external
Spark (`muse`) and Codex workers. The panel is read-only — it never launches
a worker; the only mutating actions are killing a process by PID and deleting
the files of finished heartbeats.

What it shows:

- Claude Code main sessions and subagents (read from `~/.claude/projects` transcripts),
- Spark and Codex workers (read from `~/.claude/worker-status` heartbeats),
- for each task: model, effort, git branch, current tool, context and token usage — wherever that can reliably be determined from the source file.

---

## What a row shows

The panel has **no** per-engine section, and no separate section for waiting
sessions. The layout is a single **tree rooted in the conversation**: the
root of each branch is a Claude Code session, and beneath it — indented one
fixed step per level — hang all of its subtasks **regardless of engine**:
Claude subagents and Spark/Codex workers pinned by `sessionId` (see
[CRITICAL: how to use it](#critical-how-to-use-it)). A session stays visible
in the tree even when it isn't doing anything itself, as long as it has at
least one visible child — otherwise starting a single worker would collapse
the whole branch. At the end of the tree sits the fallback group **"Unassigned"**
for workers that can't be pinned to any visible conversation. The panel
header carries a single number — the total count of visible tasks across the
whole tree, not a sum per section (since there's no longer a section per
engine).

A single row consists of:

| Element | Description |
| --- | --- |
| **Status badge** | The row's only carrier of color — see the [Statuses](#statuses) section. |
| **Title** | Name of the session/subagent/worker (for a subagent: its `subtitle`, if present). |
| **Meta line** | Second line, text with no background. **Starts with the engine name** (`claude`/`codex`/`spark`, lowercase) — with no per-engine sections, this is the only way for a row to say on its own what it's running on. The engine name is **omitted** when the shortened model already starts with it (e.g. `spark-1.3` on engine `spark` — repeating it would be pure noise). Next, in two tiers of visual hierarchy: for a subagent, its role + shortened **model** in the foreground color; the rest (**effort**, **repo** name, **branch**, PID, **current tool/activity**, context, tokens) in the muted descriptive color, separated by `·`. Examples: `claude · opus · high · MyApp · main · Bash · 429k/1M · 4.2M`, `spark-1.3 · medium · WorkerBoard · PID 33664` (here `spark` is omitted). |
| **Context bar** | A narrow fill bar under the meta line — drawn **only** when both `contextTokens` and `contextWindow` are known (without that data the card ends after two lines, with no empty bar). |

The context bar's color is a **signal, not decoration** — thresholds are
inclusive (`>=`):

| Fill | Color |
| --- | --- |
| < 80% | neutral |
| >= 80% | yellow (warning) |
| >= 95% | red (critical) |

The context window size (the bar's denominator) **isn't present in the
transcript** — it comes from the `workerBoard.contextWindowTokens` setting
(see [Configuration](#configuration)); it's never read from any session file.

---

## Statuses

The panel shows **only** tasks in one of two visible states — everything
else (finished, inactive, abandoned) is hidden; the panel is not a history
log.

| Status | Meaning |
| --- | --- |
| `w toku` (in progress) / `aktywna` (active) | The task is genuinely working right now. |
| `czeka` (waiting) | The Claude Code session closed its turn and is waiting for a human to react. |

Rule for determining status (positive evidence from the transcript, never a
guessed activity-time threshold):

- **`w toku` (in progress)** — the last assistant message has
  `stop_reason: tool_use`, and either (a) that specific tool call has no
  result yet (`tool_result`) in the file, or (b) the turn is still formally
  open (same `stop_reason: tool_use` condition, no newer user message) **and**
  the transcript file was written to within the last **60 seconds**. The
  second case covers the window where the model is composing its next step —
  momentarily there's no unpaired tool call in the file, but a fresh write to
  disk proves the session is working.
- **`czeka` (waiting)** — the assistant closed its turn (a terminal
  `stop_reason`: `end_turn`, `stop_sequence`, or `max_tokens`) and there's no
  newer user message after it.
- **a deliberately hidden state** — "the user sent a message, but nothing has
  been produced yet." From the transcript file alone there's no way to tell
  a model that's currently thinking apart from a message sitting queued with
  no reaction at all — the panel prefers to show nothing rather than guess
  either way.

Subagents and workers (Spark/Codex) never get the `czeka` (waiting) status —
that status exists only for Claude Code main sessions.

"`czeka` (waiting)" **is no longer a separate section** — it's a row state. A
waiting session sits in the tree exactly where its place in the conversation
puts it (the root of its branch), just **dimmed** (reduced opacity) and with
a **frozen counter** `for X min` — unlike `w toku` (in progress) tasks, whose
counter ticks every second, this one stands still because the session isn't
doing anything anymore.

---

## Requirements

| Requirement | Role | Hard/soft |
| --- | --- | --- |
| **Node.js >= 20** (recommended: **26**) | building the extension | hard |
| **npm** | building the extension | hard |
| **VS Code** or **VS Code Insiders**, with the `code`/`code-insiders` CLI available — either on PATH or in the standard install location | running the panel | hard |
| **WSL with an Ubuntu distribution** + the `muse` command in it | **Spark** workers | soft |
| **`codex` on PATH** | **Codex** workers | soft |

A missing soft requirement doesn't block installation — the installer warns
and continues; the part of the panel that doesn't need the missing tool
works normally.

---

## Installation

```powershell
git clone <this-repository-url>
cd WorkerBoard
powershell -File install.ps1
```

The script runs on the Windows PowerShell 5.1 that ships with every Windows
install — no separate PowerShell 7 setup is required. If PowerShell 7
(`pwsh`) is installed, `pwsh -File install.ps1` works identically.

The script, in order: checks requirements (see above), builds the package
(`npm ci`/`npm install` → `npm run build` → `npx @vscode/vsce package`),
installs the extension in every detected VS Code edition, and deploys two
dependencies that live outside the repository into `~/.claude/` (see the
[CRITICAL: how to use it](#critical-how-to-use-it) section).

Once it's done:

1. In VS Code: `Ctrl+Shift+P` → **`Developer: Reload Window`**.
2. `View` → `Output` → pick the **`Worker Board`** channel.
3. An entry `Worker Board <version> uruchomiony` ("Worker Board <version>
   started") should appear — that's the only reliable way to confirm which
   version is actually running.

**Switches:**

- `-SkipBuild` — skips `npm ci`/`build`/`vsce package` and installs the
  newest (by modification time) `.vsix` file already present in the
  repository directory. Useful when the package was built moments earlier.
- `-DryRun` — prints the full plan of action (detected requirements, what
  would be built/installed/overwritten), **changing nothing** on disk.

The installer is **idempotent** — rerunning it against an unchanged
repository and `~/.claude/` state gives the same outcome (aside from the
repeated uninstall+install of the extension, which VS Code performs on
every run regardless, since it can keep the old copy when the version
number hasn't changed).

---

## CRITICAL: how to use it

> **Spark and Codex MUST be launched through
> `~/.claude/bin/worker-run.ps1`. Calling raw `wsl.exe`/`codex.cmd` directly,
> bypassing the wrapper, still starts the worker correctly, but the Worker
> Board panel won't see it at all — neither that it's running nor that it
> finished.**

Reason: Spark leaves no trace on disk beyond `~/.config/muse` (just
`auth.json`/`settings.json`/`trust.json`, zero session history), and Codex
writes no marker of a run's completion at all. The wrapper fixes this
itself — it writes and closes a state record in
`~/.claude/worker-status/<id>.json`, plus a full log in
`~/.claude/worker-status/logs/<id>.log`, for the entire duration of the run.

**Pinning a worker to a conversation is automatic.** The state record
carries a `sessionId` field, which the panel uses to attach the worker
under the right tree branch (see [What a row shows](#what-a-row-shows)).
The wrapper fills it in on its own from the `CLAUDE_CODE_SESSION_ID`
environment variable, inherited by the child process — **nothing needs to
be passed by hand**. The field is optional: records written before this
mechanism existed, and workers launched outside Claude Code (without that
variable in the environment), don't have it and land in the "Unassigned"
group.

The installer also deploys a modified version of the Claude Code skill
`external-workers` (`~/.claude/skills/external-workers/SKILL.md`) — thanks
to it, **Claude Code calls the wrapper itself** whenever it delegates work
to Spark or Codex; you don't have to remind it every conversation.

**Spark (`muse`) — via WSL:**

```powershell
C:\Users\<username>\.claude\bin\worker-run.ps1 `
  -Engine spark `
  -Title "Short description shown on the card in the panel" `
  -BriefFile C:\...\brief.md `
  -Repo D:\projects\DTCode\RepoName
```

**Codex — natively on Windows:**

```powershell
C:\Users\<username>\.claude\bin\worker-run.ps1 `
  -Engine codex `
  -Title "Short description shown on the card in the panel" `
  -BriefFile C:\...\brief.md `
  -Repo D:\projects\DTCode\RepoName `
  -Model gpt-5.6-luna -Effort low
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `-Engine` | `spark` or `codex` (required). |
| `-Title` | Short description shown on the card in the panel (required). |
| `-BriefFile` | Path to the file with the full brief for the worker — the worker doesn't see the conversation (required). |
| `-Repo` | The repository directory the worker should work in (required). For Spark, the wrapper translates the Windows path to WSL itself. |
| `-Model` | Overrides the default model (`muse-spark-1.3-contributor` for Spark, `gpt-5.6-terra` for Codex). |
| `-Effort` | Overrides the default effort (`xhigh` for Spark, `medium` for Codex). |
| `-Passthru` | Extra CLI flags passed through unchanged to `muse exec`/`codex exec`. |

The full justification for every mandatory flag inside the wrapper
(`-d Ubuntu`, `--trust-workspace`, `--approval-mode never`, path translation
for Spark; `-s workspace-write`, `--skip-git-repo-check`, brief via stdin
for Codex) is documented in
`deploy/claude/skills/external-workers/SKILL.md`.

---

## Configuration

All `workerBoard.*` keys (`Settings` → `Worker Board` in VS Code):

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `workerBoard.pollIntervalMs` | number | `5000` | Interval between full refreshes, in milliseconds. |
| `workerBoard.claudeLookbackHours` | number | `24` | How many hours back to consider Claude Code sessions when scanning. |
| `workerBoard.subagentStaleAfterMinutes` | number | `15` | After how many minutes with no transcript write a subagent with no completion signal is considered `porzucony` (abandoned). |
| `workerBoard.contextWindowTokens` | number | `1000000` | Context window size used as the fill bar's denominator. The Claude Code transcript doesn't contain this value, so it has to be supplied. |
| `workerBoard.waitingLookbackMinutes` | number | `120` | How long a session waiting for a reply stays visible in the panel after its last activity. |
| `workerBoard.claudeProjectsPath` | string | `""` | Path to the `~/.claude/projects` directory. Empty = default value. |
| `workerBoard.workerStatusPath` | string | `""` | Path to the `~/.claude/worker-status` directory. Empty = default value. |
| `workerBoard.codexSessionsPath` | string | `""` | Path to the `~/.codex/sessions` directory. Empty = default value. |

---

## What the panel does not show and why

- **Spark doesn't report tokens.** The `muse exec --json` stream contains no
  token-usage events at all — the `tokensUsed`/`contextTokens` field for
  Spark tasks is always absent (`undefined`), never zero.
- **The context window size doesn't come from the transcript.** It's always
  the value from `workerBoard.contextWindowTokens` — the panel has no way to
  read the model's real limit from a session file.
- **Agents launched through the `workflows` feature** are out of scanning
  scope — the panel recognizes main sessions and subagents in the standard
  transcript format, not agents from older/alternative harnesses.
- **The "Kill" button on a Spark task kills `wsl.exe`, not the `muse`
  process on the WSL side.** The PID stored in the heartbeat is the PID of
  the `wsl.exe` process on the Windows side (the only thing the panel can
  check and kill) — the `muse` invocation itself inside WSL may be left
  orphaned after `wsl.exe` is killed and need manual cleanup on the Linux
  side.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| The panel shows stale data or no badges after installation | The VS Code window wasn't reloaded. `Ctrl+Shift+P` → `Developer: Reload Window`, then check the version in `View` → `Output` → `Worker Board`. |
| The panel is empty | That's normal — the panel shows only tasks genuinely running right now (`w toku` (in progress) / `czeka` (waiting)), not history. An empty panel means nothing is running right now. |
| A worker (Spark/Codex) doesn't show up in the panel even though it's running | It was launched bypassing `~/.claude/bin/worker-run.ps1` — see the [CRITICAL: how to use it](#critical-how-to-use-it) section. A raw `wsl.exe`/`codex.cmd` call leaves no trace the panel could read. |
| The installer stops at step A | A hard requirement is missing (Node < 20, no `npm`, no `code`/`code-insiders` on PATH) — the table the installer prints shows which one. |
| The installer reports missing `muse`/`codex` | That's a warning (a soft requirement), not an error — the rest of the panel works, only that engine's workers will be invisible. |
| A Spark/Codex worker ended up in the "Unassigned" group instead of under the right session | Its state record has no `sessionId` field — either a record written before this mechanism existed, or a worker launched outside Claude Code (without the `CLAUDE_CODE_SESSION_ID` environment variable in the process's environment). That's not a bug, just missing data to pin it with — the worker is still visible, just outside the conversation tree. |

---

## Publishing (optional)

The extension is ready to be published on the Visual Studio Marketplace —
the manifest has every required field, a PNG icon, and a `LICENSE` file.
The full procedure (PAT, login, `vsce publish`, Open VSX) is described in
[`PUBLISHING.md`](PUBLISHING.md) (Polish only — an internal maintainer
document).

---

## Repository structure

```
WorkerBoard/
├── install.ps1                  # installer - see the Installation section
├── package.json                 # extension manifest (contributes, configuration, scripts)
├── esbuild.mjs                  # builds the extension into dist/extension.js
├── src/                         # extension code (scanners, model, view)
├── media/                       # panel webview (main.js, main.css, board.svg activity-bar icon, icon.png Marketplace icon)
├── scripts/                     # helper scripts (incl. the smoke test)
├── deploy/
│   └── claude/                  # source of truth for out-of-repo dependencies
│       ├── bin/worker-run.ps1               # copy -> ~/.claude/bin/
│       └── skills/external-workers/SKILL.md # copy -> ~/.claude/skills/external-workers/
└── dist/                        # build output (git-ignored)
```

---

# Polski

[English](#worker-board) | **Polski**

Rozszerzenie jest bezpłatne i dostępne w Visual Studio Marketplace:
`code --install-extension dtcode.worker-board`.

## Czym to jest

Rozszerzenie VS Code z panelem w pasku bocznym, pokazującym w jednym miejscu
wszystkie zadania AI wykonywane **w tej chwili**: sesje i subagentów Claude
Code oraz workery zewnętrzne Spark (`muse`) i Codex. Panel jest wyłącznie
czytelnikiem — nie uruchamia żadnego workera, jedyne operacje modyfikujące to
zabicie procesu po PID i skasowanie plików zakończonych heartbeatów.

Co pokazuje:

- sesje główne i subagentów Claude Code (czytane z transkryptów `~/.claude/projects`),
- workery Spark i Codex (czytane z heartbeatów `~/.claude/worker-status`),
- dla każdego zadania: model, effort, gałąź gita, bieżące narzędzie, zużycie kontekstu i tokenów — tam, gdzie da się to wiarygodnie wyznaczyć z pliku źródłowego.

---

## Co widać na wierszu

Panel **nie ma** sekcji per silnik ani osobnej sekcji na sesje czekające.
Układ to jedno **drzewo zakorzenione w konwersacji**: korzeniem każdej gałęzi
jest sesja Claude Code, a pod nią — wcięte, o stały krok na każdym kolejnym
poziomie — wiszą wszystkie jej podzadania **niezależnie od silnika**:
subagenci Claude oraz workery Spark i Codex przypięte przez `sessionId`
(patrz [KRYTYCZNE: jak używać](#krytyczne-jak-używać)). Sesja zostaje
widoczna w drzewie nawet wtedy, gdy sama nic nie robi, o ile ma choć jedno
widoczne dziecko — inaczej start pojedynczego workera zwijałby całą gałąź.
Na końcu drzewa stoi grupa zapasowa **„Bez przypisania"** na workery, których
nie da się przypiąć do żadnej widocznej konwersacji. Nagłówek panelu niesie
jedną liczbę — łączną liczbę widocznych zadań w całym drzewie, nie sumę per
sekcja (bo sekcji per silnik już nie ma).

Pojedynczy wiersz składa się z:

| Element | Opis |
| --- | --- |
| **Plakietka statusu** | Jedyny nośnik koloru w wierszu — patrz sekcja [Statusy](#statusy). |
| **Tytuł** | Nazwa sesji/subagenta/workera (dla subagenta: jego `subtitle`, jeśli jest). |
| **Linia meta** | Drugi wiersz, tekst bez tła. **Zaczyna się od nazwy silnika** (`claude`/`codex`/`spark`, małymi literami) — bez sekcji per silnik to jedyny sposób, żeby wiersz sam mówił, na czym leci. Nazwa silnika jest **pomijana**, gdy skrócony model już się od niej zaczyna (np. `spark-1.3` przy silniku `spark` — powtórzenie byłoby czystym szumem). Dalej, w dwóch stopniach hierarchii wizualnej: dla subagenta jego rola + skrócony **model** w kolorze pierwszoplanowym, reszta (**effort**, nazwa **repo**, **gałąź**, PID, **bieżące narzędzie/aktywność**, kontekst, tokeny) w kolorze opisowym, oddzielone `·`. Przykłady: `claude · opus · high · MyApp · main · Bash · 429k/1M · 4.2M`, `spark-1.3 · medium · WorkerBoard · PID 33664` (tu `spark` jest pominięty). |
| **Pasek kontekstu** | Wąski pasek wypełnienia pod linią meta — rysowany **tylko**, gdy znane są jednocześnie `contextTokens` i `contextWindow` (bez tych danych karta kończy się na dwóch liniach, bez pustego paska). |

Kolor paska kontekstu jest **sygnałem, nie dekoracją** — progi liczone są
włącznie (`>=`):

| Wypełnienie | Kolor |
| --- | --- |
| < 80% | neutralny |
| >= 80% | żółty (ostrzeżenie) |
| >= 95% | czerwony (krytyczny) |

Rozmiar okna kontekstu (mianownik paska) **nie występuje w transkrypcie** —
pochodzi z ustawienia `workerBoard.contextWindowTokens` (patrz
[Konfiguracja](#konfiguracja)), nie jest odczytywany z żadnego pliku sesji.

---

## Statusy

Panel pokazuje **wyłącznie** zadania w jednym z dwóch stanów widocznych —
wszystko inne (zakończone, nieaktywne, porzucone) jest ukryte, panel nie jest
historią.

| Status | Znaczenie |
| --- | --- |
| **w toku** / **aktywna** | Zadanie realnie pracuje w tej chwili. |
| **czeka** | Sesja Claude Code domknęła turę i czeka na reakcję człowieka. |

Reguła wyznaczania statusu (dowód pozytywny z transkryptu, nigdy próg czasowy
zgadujący aktywność):

- **w toku** — ostatnia wiadomość asystenta ma `stop_reason: tool_use`, i
  albo (a) to konkretne wywołanie narzędzia nie ma jeszcze wyniku
  (`tool_result`) w pliku, albo (b) tura wciąż jest formalnie otwarta (ten sam
  warunek `stop_reason: tool_use`, brak nowszej wiadomości użytkownika) **i**
  plik transkryptu był dopisywany w ciągu ostatnich **60 sekund**. Drugi
  przypadek pokrywa okno, w którym model komponuje kolejny krok — w pliku
  chwilowo nie ma żadnego niesparowanego wywołania narzędzia, ale świeży zapis
  na dysku dowodzi, że sesja pracuje.
- **czeka** — asystent domknął turę (`stop_reason` kończący: `end_turn`,
  `stop_sequence` lub `max_tokens`) i nie ma po niej nowszej wiadomości
  użytkownika.
- **stan celowo ukryty** — "użytkownik wysłał wiadomość, ale jeszcze nic nie
  powstało". Z samego pliku transkryptu nie da się odróżnić modelu, który w
  tej chwili myśli, od wiadomości stojącej w kolejce bez żadnej reakcji —
  panel woli nic nie pokazać niż zgadywać w dowolną stronę.

Subagenci i workery (Spark/Codex) nigdy nie dostają statusu "czeka" — ten
status istnieje wyłącznie dla sesji głównych Claude Code.

„Czeka" **nie jest już osobną sekcją** — to stan wiersza. Sesja czekająca
stoi w drzewie dokładnie tam, gdzie wynika to z jej miejsca w konwersacji
(korzeń swojej gałęzi), tyle że **wygaszona** (obniżona krycie) i z
**zamrożonym licznikiem** `od X min` — w przeciwieństwie do zadań "w toku",
których licznik tyka co sekundę, ten stoi w miejscu, bo sesja nic już nie
robi.

---

## Wymagania

| Wymaganie | Rola | Twarde/miękkie |
| --- | --- | --- |
| **Node.js >= 20** (zalecane: **26**) | budowa rozszerzenia | twarde |
| **npm** | budowa rozszerzenia | twarde |
| **VS Code** albo **VS Code Insiders**, z dostępnym CLI `code`/`code-insiders` — w PATH albo w standardowej lokalizacji instalacji | uruchomienie panelu | twarde |
| **WSL z dystrybucją Ubuntu** + polecenie `muse` w niej | workery **Spark** | miękkie |
| **`codex` w PATH** | workery **Codex** | miękkie |

Brak miękkiego wymagania nie blokuje instalacji — instalator ostrzega i
kontynuuje; ta część panelu, która nie wymaga brakującego narzędzia, działa
normalnie.

---

## Instalacja

```powershell
git clone <adres-tego-repozytorium>
cd WorkerBoard
powershell -File install.ps1
```

Skrypt działa na Windows PowerShell 5.1, który jest częścią każdej instalacji
Windows — nie trzeba osobno instalować PowerShell 7. Jeśli PowerShell 7
(`pwsh`) jest zainstalowany, `pwsh -File install.ps1` działa identycznie.

Skrypt kolejno: sprawdza wymagania (patrz wyżej), buduje pakiet (`npm ci`/
`npm install` → `npm run build` → `npx @vscode/vsce package`), instaluje
rozszerzenie we wszystkich wykrytych edycjach VS Code i wdraża dwie
zależności żyjące poza repozytorium do `~/.claude/` (patrz sekcja
[KRYTYCZNE: jak używać](#krytyczne-jak-używać)).

Po zakończeniu:

1. W VS Code: `Ctrl+Shift+P` → **`Developer: Reload Window`**.
2. `View` → `Output` → wybierz kanał **`Worker Board`**.
3. Powinien pojawić się wpis `Worker Board <wersja> uruchomiony` — to jedyny
   pewny sposób na potwierdzenie, która wersja faktycznie działa.

**Przełączniki:**

- `-SkipBuild` — pomija `npm ci`/`build`/`vsce package` i instaluje
  najnowszy (wg czasu modyfikacji) plik `.vsix` już obecny w katalogu
  repozytorium. Przydatne, gdy pakiet został zbudowany chwilę wcześniej.
- `-DryRun` — wypisuje pełny plan działania (wykryte wymagania, co zostałoby
  zbudowane/zainstalowane/nadpisane), **niczego nie zmieniając** na dysku.

Instalator jest **idempotentny** — powtórne uruchomienie z niezmienionym
stanem repozytorium i `~/.claude/` daje ten sam wynik (poza ponownym
uninstall+install rozszerzenia, które VS Code i tak wykonuje przy każdym
przebiegu, bo potrafi zachować starą kopię przy niezmienionym numerze
wersji).

---

## KRYTYCZNE: jak używać

> **Spark i Codex MUSZĄ być uruchamiane przez
> `~/.claude/bin/worker-run.ps1`. Wywołanie surowego `wsl.exe`/`codex.cmd`
> z pominięciem wrappera odpala worker poprawnie, ale panel Worker Board
> nie zobaczy go w ogóle — ani że trwa, ani że się skończył.**

Powód: Spark nie zostawia żadnego śladu na dysku poza `~/.config/muse`
(tylko `auth.json`/`settings.json`/`trust.json`, zero historii sesji), a
Codex nie zapisuje żadnego znacznika zakończenia przebiegu. Wrapper naprawia
to sam — pisze i domyka rekord stanu w
`~/.claude/worker-status/<id>.json` oraz pełny log w
`~/.claude/worker-status/logs/<id>.log` przez cały czas trwania przebiegu.

**Przypisanie workera do konwersacji jest automatyczne.** Rekord stanu niesie
pole `sessionId`, którym panel dopina worker pod właściwą gałąź drzewa (patrz
[Co widać na wierszu](#co-widać-na-wierszu)). Wrapper wypełnia je samodzielnie
ze zmiennej środowiskowej `CLAUDE_CODE_SESSION_ID`, dziedziczonej przez
proces potomny — **nie trzeba niczego podawać ręcznie**. Pole jest opcjonalne:
rekordy zapisane przed wprowadzeniem tego mechanizmu oraz workery uruchomione
poza Claude Code (bez tej zmiennej w środowisku) go nie mają i trafiają do
grupy „Bez przypisania".

Instalator wdraża też zmodyfikowaną wersję skilla Claude Code
`external-workers` (`~/.claude/skills/external-workers/SKILL.md`) —
dzięki niej **Claude Code sam wywołuje wrapper**, gdy deleguje pracę do
Sparka lub Codexa; nie trzeba mu tego przypominać w każdej rozmowie.

**Spark (`muse`) — przez WSL:**

```powershell
C:\Users\<uzytkownik>\.claude\bin\worker-run.ps1 `
  -Engine spark `
  -Title "Krotki opis widoczny na karcie w panelu" `
  -BriefFile C:\...\brief.md `
  -Repo D:\projects\DTCode\NazwaRepo
```

**Codex — natywnie na Windows:**

```powershell
C:\Users\<uzytkownik>\.claude\bin\worker-run.ps1 `
  -Engine codex `
  -Title "Krotki opis widoczny na karcie w panelu" `
  -BriefFile C:\...\brief.md `
  -Repo D:\projects\DTCode\NazwaRepo `
  -Model gpt-5.6-luna -Effort low
```

Parametry:

| Parametr | Znaczenie |
| --- | --- |
| `-Engine` | `spark` albo `codex` (wymagane). |
| `-Title` | Krótki opis pokazywany na karcie w panelu (wymagane). |
| `-BriefFile` | Ścieżka do pliku z pełnym briefem dla workera — worker nie widzi rozmowy (wymagane). |
| `-Repo` | Katalog repozytorium, w którym worker ma pracować (wymagane). Dla Sparka wrapper sam tłumaczy ścieżkę Windows → WSL. |
| `-Model` | Nadpisuje model domyślny (`muse-spark-1.3-contributor` dla Sparka, `gpt-5.6-terra` dla Codexa). |
| `-Effort` | Nadpisuje effort domyślny (`xhigh` dla Sparka, `medium` dla Codexa). |
| `-Passthru` | Dodatkowe flagi CLI przekazywane bez zmian do `muse exec`/`codex exec`. |

Pełne uzasadnienie każdej z obowiązkowych flag wewnątrz wrappera (`-d Ubuntu`,
`--trust-workspace`, `--approval-mode never`, tłumaczenie ścieżek dla Sparka;
`-s workspace-write`, `--skip-git-repo-check`, brief przez stdin dla Codexa)
opisuje `deploy/claude/skills/external-workers/SKILL.md`.

---

## Konfiguracja

Wszystkie klucze `workerBoard.*` (`Ustawienia` → `Worker Board` w VS Code):

| Klucz | Typ | Domyślnie | Opis |
| --- | --- | --- | --- |
| `workerBoard.pollIntervalMs` | number | `5000` | Odstęp między pełnymi odświeżeniami w milisekundach. |
| `workerBoard.claudeLookbackHours` | number | `24` | Ile godzin wstecz brać pod uwagę sesje Claude Code przy skanowaniu. |
| `workerBoard.subagentStaleAfterMinutes` | number | `15` | Po ilu minutach bez zapisu do transkryptu subagent bez sygnału ukończenia jest uznawany za porzucony. |
| `workerBoard.contextWindowTokens` | number | `1000000` | Rozmiar okna kontekstu używany jako mianownik paska wypełnienia. Transkrypt Claude Code nie zawiera tej wartości, więc trzeba ją podać. |
| `workerBoard.waitingLookbackMinutes` | number | `120` | Jak długo po ostatniej aktywności sesja czekająca na odpowiedź pozostaje widoczna w panelu. |
| `workerBoard.claudeProjectsPath` | string | `""` | Ścieżka do katalogu `~/.claude/projects`. Puste = wartość domyślna. |
| `workerBoard.workerStatusPath` | string | `""` | Ścieżka do katalogu `~/.claude/worker-status`. Puste = wartość domyślna. |
| `workerBoard.codexSessionsPath` | string | `""` | Ścieżka do katalogu `~/.codex/sessions`. Puste = wartość domyślna. |

---

## Czego panel nie pokazuje i dlaczego

- **Spark nie raportuje tokenów.** Strumień `muse exec --json` nie zawiera
  żadnych zdarzeń o zużyciu tokenów — pole `tokensUsed`/`contextTokens` dla
  zadań Spark jest zawsze nieobecne (`undefined`), nigdy zero.
- **Rozmiar okna kontekstu nie pochodzi z transkryptu.** To zawsze wartość z
  `workerBoard.contextWindowTokens` — panel nie ma sposobu wyczytać
  rzeczywistego limitu modelu z pliku sesji.
- **Agenci uruchamiani przez funkcję `workflows`** są poza zakresem
  skanowania — panel rozpoznaje sesje główne i subagentów w standardowym
  formacie transkryptu, nie agentów starszych/alternatywnych harnessów.
- **Przycisk "Zabij" na zadaniu Spark ubija `wsl.exe`, nie proces `muse` po
  stronie WSL.** PID zapisany w heartbeacie to PID procesu `wsl.exe` po
  stronie Windows (to jedyne, co panel potrafi sprawdzić i zabić) — samo
  wywołanie `muse` wewnątrz WSL po zabiciu `wsl.exe` może pozostać
  osierocone i wymagać ręcznego posprzątania po stronie Linuksa.

---

## Rozwiązywanie problemów

| Objaw | Przyczyna / rozwiązanie |
| --- | --- |
| Panel pokazuje stare dane albo brak plakietek po instalacji | Okno VS Code nie zostało przeładowane. `Ctrl+Shift+P` → `Developer: Reload Window`, potem sprawdź wersję w `View` → `Output` → `Worker Board`. |
| Panel jest pusty | To normalne — panel pokazuje wyłącznie zadania realnie trwające teraz (`w toku`/`czeka`), nie historię. Pusty panel = nic teraz nie działa. |
| Worker (Spark/Codex) nie pojawia się w panelu mimo że działa | Został uruchomiony z pominięciem `~/.claude/bin/worker-run.ps1` — zobacz sekcję [KRYTYCZNE: jak używać](#krytyczne-jak-używać). Surowe wywołanie `wsl.exe`/`codex.cmd` nie zostawia śladu, który panel mógłby odczytać. |
| Instalator przerywa na kroku A | Brakuje twardego wymagania (Node < 20, brak `npm`, brak `code`/`code-insiders` w PATH) — tabela wypisana przez instalator wskazuje które. |
| Instalator zgłasza brak `muse`/`codex` | To ostrzeżenie (wymaganie miękkie), nie błąd — reszta panelu działa, tylko dany silnik workerów będzie niewidoczny. |
| Worker Spark/Codex wylądował w grupie „Bez przypisania" zamiast pod właściwą sesją | Jego rekord stanu nie ma pola `sessionId` — to rekord zapisany przed wprowadzeniem tego mechanizmu, albo worker uruchomiony poza Claude Code (bez zmiennej środowiskowej `CLAUDE_CODE_SESSION_ID` w środowisku procesu). To nie jest błąd, tylko brak danych do przypięcia — worker i tak jest widoczny, tylko poza drzewem konwersacji. |

---

## Publikacja (opcjonalnie)

Rozszerzenie jest gotowe do publikacji w Visual Studio Marketplace — manifest
ma komplet wymaganych pól, ikonę PNG i plik `LICENSE`. Pełna procedura (PAT,
logowanie, `vsce publish`, Open VSX) opisana jest w [`PUBLISHING.md`](PUBLISHING.md).

---

## Struktura repozytorium

```
WorkerBoard/
├── install.ps1                  # instalator - patrz sekcja Instalacja
├── package.json                 # manifest rozszerzenia (contributes, konfiguracja, skrypty)
├── esbuild.mjs                  # build rozszerzenia do dist/extension.js
├── src/                         # kod rozszerzenia (skanery, model, widok)
├── media/                       # webview panelu (main.js, main.css, board.svg ikona paska aktywności, icon.png ikona Marketplace)
├── scripts/                     # skrypty pomocnicze (m.in. smoke test)
├── deploy/
│   └── claude/                  # zrodlo prawdy dla zaleznosci poza repo
│       ├── bin/worker-run.ps1               # kopia -> ~/.claude/bin/
│       └── skills/external-workers/SKILL.md # kopia -> ~/.claude/skills/external-workers/
└── dist/                        # wynik budowy (ignorowany przez git)
```

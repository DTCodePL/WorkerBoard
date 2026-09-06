# Worker Board

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

Panel grupuje zadania w sekcje: po jednej na każdy silnik (Claude, Spark,
Codex) oraz osobną sekcję **"Czekają na Ciebie"** na sesje Claude Code
czekające na reakcję człowieka. Nagłówek każdej sekcji niesie **licznik** —
liczbę kart, które w danej chwili do niej należą.

Pojedynczy wiersz (karta) składa się z:

| Element | Opis |
| --- | --- |
| **Plakietka statusu** | Jedyny nośnik koloru w wierszu — patrz sekcja [Statusy](#statusy). |
| **Tytuł** | Nazwa sesji/subagenta/workera (dla subagenta: jego `subtitle`, jeśli jest). |
| **Linia meta** | Drugi wiersz karty, tekst bez tła, w dwóch stopniach hierarchii wizualnej: `agentType` + skrócony **model** w kolorze pierwszoplanowym, reszta (**effort**, nazwa **repo**, **gałąź**, **bieżące narzędzie/aktywność**, PID, kontekst, tokeny) w kolorze opisowym, oddzielone `·`. |
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

---

## Wymagania

| Wymaganie | Rola | Twarde/miękkie |
| --- | --- | --- |
| **Node.js >= 20** (zalecane: **26**) | budowa rozszerzenia | twarde |
| **npm** | budowa rozszerzenia | twarde |
| **VS Code** albo **VS Code Insiders** (CLI `code`/`code-insiders` w PATH) | uruchomienie panelu | twarde |
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
pwsh -File install.ps1
```

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

---

## Publikacja (opcjonalnie)

Dziś rozszerzenie jest przeznaczone do **instalacji ręcznej z pliku `.vsix`**
(dokładnie tak, jak robi to `install.ps1`) — do tego nie potrzeba niczego
więcej niż jest w tym repozytorium.

Gdyby w przyszłości padła decyzja o publikacji w sklepie rozszerzeń, warto
wiedzieć:

- **Manifest wymaga czterech pól, które już mamy:** `name`, `version`
  (SemVer), `publisher`, `engines.vscode` (nie może być `*`). Samo
  `vsce publish` nie wymaga żadnych dodatkowych pól manifestu — wymaga
  natomiast **zarejestrowanego publishera** i **poświadczenia** (PAT, OIDC
  albo Entra ID).
- **Przed publikacją trzeba dodatkowo uzupełnić:** pole `repository`, pole
  `license` oraz plik `LICENSE` (wybór licencji należy do właściciela — nie
  jest to zrobione za niego przez ten instalator), a także `icon` — musi być
  plikiem **PNG o rozmiarze minimum 128×128 px** (zalecane 256×256 dla
  ekranów Retina); **SVG jest niedozwolony** jako ikona publikowanego
  rozszerzenia. Obecna `media/board.svg` to ikona kontenera w pasku
  aktywności VS Code — inna rzecz, i nie zastępujemy jej tą ikoną.
- **Zalecane, choć nieobowiązkowe:** `categories` (wyłącznie wartości z
  zamkniętej listy Marketplace), `keywords` (limit 30 wpisów),
  `galleryBanner`.
- Bieżąca wersja stabilna VS Code to **1.136.1** (2 września 2026). Nasza
  deklaracja `engines.vscode: "^1.96.0"` oznacza zgodność od 1.96.0 wzwyż —
  to około czterdziestu wydań minor wstecz. To jest **obietnica
  kompatybilności, nie dowód** — nikt tego rozszerzenia na 1.96 realnie nie
  testował.
- Alternatywą dla Visual Studio Marketplace jest **Open VSX**
  (rejestr używany m.in. przez VSCodium i Theia): wymaga konta Eclipse,
  podpisanego Publisher Agreement, namespace zgodnego z `publisher`, i
  publikacji przez `npx ovsx publish`. Dla narzędzia instalowanego ręcznie,
  jak dziś, nie jest potrzebna.

---

## Struktura repozytorium

```
WorkerBoard/
├── install.ps1                  # instalator - patrz sekcja Instalacja
├── package.json                 # manifest rozszerzenia (contributes, konfiguracja, skrypty)
├── esbuild.mjs                  # build rozszerzenia do dist/extension.js
├── src/                         # kod rozszerzenia (skanery, model, widok)
├── media/                       # webview panelu (main.js, main.css)
├── scripts/                     # skrypty pomocnicze (m.in. smoke test)
├── deploy/
│   └── claude/                  # zrodlo prawdy dla zaleznosci poza repo
│       ├── bin/worker-run.ps1               # kopia -> ~/.claude/bin/
│       └── skills/external-workers/SKILL.md # kopia -> ~/.claude/skills/external-workers/
└── dist/                        # wynik budowy (ignorowany przez git)
```

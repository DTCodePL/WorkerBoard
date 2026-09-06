---
name: external-workers
description: Use when delegating work to the Spark (muse) or Codex CLI workers instead of a Claude subagent - contains the exact invocation commands through the mandatory worker-run.ps1 wrapper, WSL path translation, required flags, the brief template and the validation rules. Trigger whenever the routing table in the global CLAUDE.md sends a task to Spark or Codex, or when the user asks to run something on Spark, muse, Codex, Terra, Sol, Luna or Astra.
---

# Workerzy zewnętrzni — Spark i Codex

Dwa silniki poza Claude'em, wywoływane jako procesy przez `Bash`/`PowerShell`.
**To nie są subagenci** — nie pojawią się w `/agents`, nie widać ich postępu
na żywo, startują bez kontekstu rozmowy.

Wybór silnika reguluje tabela routingu w globalnym `~/.claude/CLAUDE.md`.
Ten skill opisuje **jak** wywołać, nie **kiedy**.

## Dlaczego zawsze przez `worker-run.ps1`

Oba silniki wywołuję wyłącznie przez wrapper `C:\Users\Damian\.claude\bin\worker-run.ps1`,
nigdy surowym `wsl.exe` / `codex.cmd` bezpośrednio. Powód nie jest kosmetyczny:

- **Spark nie zostawia żadnego śladu na dysku.** `~/.config/muse` w WSL zawiera
  tylko `auth.json`, `settings.json`, `trust.json` — zero historii sesji. Bez
  wrappera panel VS Code "Worker Board" **nie widzi w ogóle**, że przebieg się
  odbył — ani że trwa, ani że się skończył.
- **Codex nie zapisuje znacznika zakończenia.** Rollout zostaje, ale nic nie
  mówi „ten przebieg jest już zamknięty".
- Wrapper naprawia to sam: pisze i domyka rekord w
  `%USERPROFILE%\.claude\worker-status\<id>.json` przez cały czas trwania
  przebiegu, oraz komplet logu w `worker-status\logs\<id>.log`.

Odpalenie surowego CLI z pominięciem wrappera **nie jest błędem funkcjonalnym**
— Spark czy Codex odpalą się i wykonają robotę — ale **czyni przebieg
niewidocznym** dla panelu. To jedyny powód zakazu, więc trzymam się go zawsze,
nawet przy szybkim, jednorazowym sprawdzeniu czegoś.

## Spark (`muse`) — przez WSL

Nie ma wersji na Windows. Działa wyłącznie w dystrybucji **Ubuntu**.

```powershell
C:\Users\Damian\.claude\bin\worker-run.ps1 `
  -Engine spark `
  -Title "Krotki opis widoczny na karcie w panelu" `
  -BriefFile C:\...\brief.md `
  -Repo D:\projects\DTCode\ZebraniFE
```

Domyślnie `-Model muse-spark-1.3-contributor`, `-Effort xhigh` — nadpisywalne
parametrami. Wrapper sam załatwia cztery rzeczy, których pominięcie psuje
przebieg po cichu (opisane tu, żeby było wiadomo, co się psuje przy obejściu
wrappera):

- **`-d Ubuntu` jest obowiązkowe.** Domyślną dystrybucją jest `docker-desktop`
  — wewnętrzna maszyna Dockera, w której `muse` nie istnieje.
- **`--trust-workspace` jest obowiązkowe.** Bez niego Spark **pomija
  `AGENTS.md`** i skille projektu (`workspace is untrusted, so it is skipped`)
  i pracuje nie znając ani jednej konwencji repo — nie zgłaszając błędu.
- **`--approval-mode never`**, inaczej worker zawiesi się na pytaniu o zgodę,
  którego nikt nie zobaczy.
- **Ścieżki muszą być w formacie WSL**: `D:\projects\X` → `/mnt/d/projects/X`.
  Dotyczy zarówno `--workspace`, jak i `--prompt-file`. Wrapper robi to sam
  (`ConvertTo-WslPath`); ręczne wywołanie wymaga tego robić samodzielnie.

Dodatkowe flagi CLI (np. `--max-model-steps <N>`, `--json`) przechodzą przez
`-Passthru`.

Skala effortu: `none|minimal|low|medium|high|xhigh|max|ultra`, domyślnie `high`
w samym CLI (wrapper nadpisuje domyślną wartością `xhigh`).

## Codex — natywnie na Windows

Zalogowany kontem ChatGPT (Plus). Domyślny model konta: `gpt-5.6-terra`.

```powershell
C:\Users\Damian\.claude\bin\worker-run.ps1 `
  -Engine codex `
  -Title "Krotki opis widoczny na karcie w panelu" `
  -BriefFile C:\...\brief.md `
  -Repo D:\projects\DTCode\ZebraniFE `
  -Model gpt-5.6-luna -Effort low
```

Domyślnie `-Model gpt-5.6-terra`, `-Effort medium`. Wrapper podaje brief przez
**stdin** (długi brief w cudzysłowach argumentu się rozjeżdża), używa
`-s workspace-write --skip-git-repo-check`, i streamuje stdout/stderr
równocześnie na konsolę i do logu.

- **Modele**: `gpt-5.6-luna` (masówka), `gpt-5.6-terra` (codzienny),
  `gpt-5.6-sol` (research w sieci), `gpt-6-astra` (ostateczność).
- **Effort `max` i `ultra` istnieją wyłącznie na `sol`.** Na `terra` i `luna`
  ich nie ma — poziomy to `minimal|low|medium|high`, domyślnie `medium`. CLI
  **nie waliduje** tego lokalnie: literówka przechodzi do API i dopiero tam
  wywala błąd, po zużyciu wiadomości. **Wrapper sprawdza tę kombinację sam i
  przerywa przed startem** — ręczne wywołanie CLI tej ochrony nie ma.
- Podtryb `codex exec review` (poza wrapperem, na gotowy przegląd kodu
  repozytorium) zostaje jak był.

**Znana usterka środowiska:** `SSL_CERT_FILE` i `NODE_EXTRA_CA_CERTS` wskazują
na nieistniejący `C:\Users\Damian\certs\win-ca-bundle.pem`, co wywala Codexowi
transport MCP. **Wrapper czyści te dwie zmienne tylko dla procesu potomnego**
(nigdy globalnie w sesji), gdy wskazują na nieistniejący plik — ręczne
wywołanie CLI musi to zrobić samodzielnie.

Dodatkowe flagi CLI przechodzą przez `-Passthru`.

## Kontrakt stanu (dla panelu VS Code)

Wrapper pisze `%USERPROFILE%\.claude\worker-status\<id>.json` (`schemaVersion`,
`id`, `engine`, `model`, `effort`, `title`, `repo`, `briefPath`, `pid`,
`startedAt`/`finishedAt` ISO 8601 UTC, `exitCode`, `status`
`running|done|failed|killed`, `logPath`) — zapis atomowy przez `.tmp` +
`Move-Item`, zamykany w `finally` nawet przy awarii dziecka czy Ctrl+C. Kod
kontraktu jest jedynym źródłem prawdy o kształcie pliku; nie duplikuję go tu
na sztywno, żeby nie rozjechał się z implementacją.

**Ograniczenie, o którym trzeba wiedzieć:** gwałtowne zabicie samego procesu
wrappera z zewnątrz (`Stop-Process -Force` na `pwsh.exe`, nie Ctrl+C w jego
własnej konsoli) nie daje wrapperowi szansy domknąć rekordu — żaden `finally`
nie wykona się w procesie ubitym `TerminateProcess`. Taki rekord zostaje na
`running` na stałe; to dlatego panel ma osobne wykrywanie martwego PID-u jako
zabezpieczenie, nie jako furtkę do ignorowania tego przypadku.

## Szablon briefu

Worker nie widzi rozmowy ani ustaleń. Brief zawiera **wszystko**:

```markdown
## Kontekst
<repo, ścieżki, stan wyjściowy — konkretnie, bez odsyłania do rozmowy>

## Specyfikacja
<DECYZJE, nie cele. Nazwy plików, klas, tokenów, sygnatury, przypadki brzegowe.>

## Obowiązujące reguły projektu
<wklejone sekcje AGENTS.md, które dotyczą tego zadania — dla Codexa zawsze,
dla Sparka można pominąć, bo --trust-workspace ładuje je sam>

## Definicja ukończenia
<co ma powstać i jak to zweryfikuję>

Jeśli któreś założenie tej specyfikacji jest błędne, ZATRZYMAJ SIĘ i zgłoś to,
zamiast wykonywać ją dosłownie.

## Wymagana sekcja raportu
Co uważasz za błędne w tej specyfikacji?
```

Ostatnie dwa punkty nie są ozdobnikiem — wykonawcy wielokrotnie obalali
przesłanki briefu i **za każdym razem mieli rację**.

## Domknięcie zadania

Raport workera **nie jest dowodem**. Zanim uznam zadanie za zrobione:

1. czytam `git diff` — czy zmienił to, co miał, i tylko to;
2. `npm run lint:fix` i `npm run format` (FE) albo `dotnet build` (BE);
3. `npm test`, jeśli dotknął czegokolwiek objętego testami;
4. sprawdzam konwencje, których obcy model najczęściej nie zna: brak `ngClass`
   i `::ng-deep`, tokeny zamiast wartości kolorów, klucze i18n w **obu**
   plikach locale, brak `@deprecated`.

Jeśli wynik odbiega od briefu — odsyłam z korektą, nie łatam sam.

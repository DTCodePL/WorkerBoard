// Zrodlo 2: sesje i subagenci Claude Code, czytani z transkryptow jsonl pod
// ~/.claude/projects. Katalog jest wylacznie do odczytu - ten modul nigdy
// nic tam nie zapisuje.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TaskEngine, TaskKind, TaskStatus, WorkerTask } from '../model.js';
import { FileCache } from '../util/file-cache.js';

// Status sesji opiera sie WYLACZNIE na dowodzie pozytywnym, nigdy na
// zgadywaniu na podstawie mtime. Zmierzone empirycznie: z samego pliku NIE
// da sie odroznic "model mysli" od "wiadomosc czeka w kolejce, nic sie nie
// dzieje" - okno czasowe po ostatniej wiadomosci user zgadywalo to pierwsze
// i myllilo sie. Dlatego:
// - Running wymaga, zeby OSTATNIA wiadomosc assistant miala stop_reason
//   "tool_use" I zeby ktorys z JEJ WLASNYCH blokow tool_use byl niesparowany.
//   Nie liczymy osieroconych tool_use z calego pliku - przerwane w
//   przeszlosci narzedzia zostaja niesparowane na zawsze i uczynilyby sesje
//   wiecznie aktywna.
// - WaitingForUser wymaga, zeby OSTATNIA wiadomosc assistant miala
//   stop_reason konczacy ture I zeby nie istnialo nic nowszego od niej
//   (zaden "prawdziwy" user, pomijajac tool_result-only i marker przerwania).
// - Kazdy inny uklad to stan NIEOBSERWOWALNY (np. jest nowszy user, a po nim
//   nic) - sesja jest wtedy ukryta, nie zgadujemy w zadna strone.
const RUNNING_STOP_REASON = 'tool_use';

// Okno "model komponuje kolejny krok". PRZYWROCONE SWIADOMIE - nie usuwac.
// Gdy narzedzie sie konczy, jego tool_result jest juz sparowany, wiec przez
// kilkadziesiat sekund generowania w pliku nie ma zadnego niesparowanego
// wywolania, a sesja realnie pracuje. Bez tego warunku panel gasnie w trakcie
// pracy - zglosil to wlasciciel po zobaczeniu pustego panelu przy dzialajacym
// zadaniu. Warunek NIE przywraca wczesniejszego bledu (sesja "aktywna" tuz po
// wiadomosci uzytkownika), bo wymaga, zeby to ASYSTENT odezwal sie jako ostatni
// (brak nowszej wiadomosci user) - stan "uzytkownik napisal i cisza" pozostaje
// ukryty.
const GENERATING_WINDOW_MS = 60_000;
const CLOSED_TURN_STOP_REASONS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

const INTERRUPT_MARKER_PREFIX = '[request interrupted by user]';

// Tresc tool_result zwracana natychmiast po zleceniu agenta asynchronicznego.
// Potwierdza wylacznie dispatch, nigdy ukonczenie pracy - bez tego wylapania
// kazdy agent async wyglada na zakonczony ulamek sekundy po starcie.
const ASYNC_DISPATCH_MARKER = /Async agent launched successfully/;

// Pola realnie zaobserwowane w 731 plikach meta.json na dysku: tylko
// agentType i spawnDepth sa obecne zawsze. toolUseId i description brakuje
// w 125 plikach (agenci ze starszych wersji harnessu, m.in. workflowy),
// model bywa obecny lub nie, stoppedByUser to rzadka flaga rekna.
interface SubagentMeta {
  readonly agentType?: string;
  readonly description?: string;
  readonly model?: string;
  readonly toolUseId?: string;
  readonly parentAgentId?: string;
  readonly spawnDepth?: number;
  readonly stoppedByUser?: boolean;
}

interface SessionMeta {
  readonly title: string | undefined;
  readonly cwd: string | undefined;
  // stop_reason OSTATNIEJ wiadomosci assistant w pliku (undefined, gdy nie
  // bylo jeszcze zadnej).
  readonly lastAssistantStopReason: string | undefined;
  readonly lastAssistantTimestampMs: number | undefined;
  // Prawda, gdy ktorykolwiek blok tool_use NALEZACY DO TEJ OSTATNIEJ
  // wiadomosci assistant nie ma nigdzie w pliku odpowiadajacego tool_result.
  // Celowo nie liczy osieroconych tool_use z wczesniejszych wiadomosci.
  readonly lastAssistantHasUnpairedOwnToolUse: boolean;
  // Prawda, gdy istnieje "prawdziwa" wiadomosc user (pomijajac te niosace
  // wylacznie tool_result oraz marker przerwania) o timestampie POZNIEJSZYM
  // niz ostatnia wiadomosc assistant - to jest stan nieobserwowalny.
  readonly hasNewerQualifyingUserMessage: boolean;
  // Timestamp najpozniejszej linii "user" niosacej wiadomosc, ktora NIE jest
  // markerem przerwania - "poczatek biezacej tury" dla licznika czasu sesji
  // (zastepuje birthtimeMs pliku, ktory mierzy wiek okna, nie wiek tury).
  // Ta definicja jest niezalezna od reguly statusu powyzej - dotyczy tylko
  // prezentacji czasu trwania.
  readonly turnStartedAtMs: number | undefined;
}

// Tolerancja na rozjazd zegarow i opoznienie zapisu przy porownywaniu mtime
// pliku agenta z timestampem najpozniejszej notyfikacji kolejki.
const NOTIFICATION_MTIME_TOLERANCE_MS = 2000;

interface LatestNotificationStatus {
  readonly status: string;
  readonly timestampMs: number;
}

// Sygnaly ukonczenia wyciagniete z jednego przejscia po pliku rodzica:
// - syncCompletedToolUseIds: tool_use_id z prawdziwym wynikiem (sciezka
//   synchroniczna) - explicite z pominieciem markera dispatchu async.
// - latestNotificationTimestampMs: agentId -> timestamp NAJPOZNIEJSZEJ linii
//   queue-operation z tym task-id, ze statusem lub bez. Agent wznowiony po
//   ukonczeniu (SendMessage) dopisuje kolejne notyfikacje "completed" do
//   TEGO SAMEGO agentId - bez sledzenia najpozniejszego czasu kazde
//   wznowienie wygladaloby na trwale zakonczone, mimo ze agent znow pracuje.
// - latestNotificationStatus: agentId -> status z NAJPOZNIEJSZEJ linii, ktora
//   faktycznie ma <status> (moze to byc wczesniejsza linia niz ta uzyta do
//   latestNotificationTimestampMs, bo czesc linii queue-operation nie niesie
//   statusu wcale).
interface CompletionSignals {
  readonly syncCompletedToolUseIds: ReadonlySet<string>;
  readonly latestNotificationTimestampMs: ReadonlyMap<string, number>;
  readonly latestNotificationStatus: ReadonlyMap<string, LatestNotificationStatus>;
}

export interface ClaudeScanResult {
  readonly tasks: readonly WorkerTask[];
  readonly warnings: readonly string[];
}

export class ClaudeSource {
  // Sygnaly ukonczenia z pliku rodzica, kluczowane sciezka pliku - budowane
  // raz na plik, nie raz na dziecko (FileCache pilnuje mtime+size).
  private readonly completionCache = new FileCache<CompletionSignals>();
  // Tytul (ostatnia linia "ai-title") i cwd (pierwsza linia ktora je niesie)
  // sesji - wyciagane jednym przejsciem po tresci, zeby nie czytac
  // wielomegabajtowego pliku dwa razy.
  private readonly sessionMetaCache = new FileCache<SessionMeta>();

  // Wolane raz na koniec kazdego pelnego skanu (patrz scanner.ts) - usuwa z
  // obu cache wpisy dla plikow, o ktore nikt juz nie pytal w tym cyklu (np.
  // sesja wypadla z okna lookback), zeby mapa nie rosla bez ograniczen przy
  // dlugo dzialajacym VS Code i rotujacych sesjach.
  public pruneCaches(): void {
    this.completionCache.pruneUnseen();
    this.sessionMetaCache.pruneUnseen();
  }

  public async scan(
    projectsRoot: string,
    lookbackHours: number,
    subagentStaleAfterMinutes: number,
    waitingLookbackMinutes: number
  ): Promise<ClaudeScanResult> {
    const warnings: string[] = [];
    let slugEntries: string[];
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      slugEntries = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return { tasks: [], warnings };
    }

    const lookbackMs = lookbackHours * 60 * 60 * 1000;
    const staleAfterMs = subagentStaleAfterMinutes * 60 * 1000;
    const waitingLookbackMs = waitingLookbackMinutes * 60 * 1000;
    const now = Date.now();
    const tasks: WorkerTask[] = [];

    for (const slug of slugEntries) {
      const slugPath = path.join(projectsRoot, slug);
      let slugFiles: string[];
      try {
        const entries = await fs.readdir(slugPath, { withFileTypes: true });
        slugFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name);
      } catch (error: unknown) {
        warnings.push(`Nie udalo sie przeczytac katalogu projektu ${slug}: ${describeError(error)}`);
        continue;
      }

      for (const fileName of slugFiles) {
        const sessionUuid = fileName.slice(0, -'.jsonl'.length);
        const sessionFilePath = path.join(slugPath, fileName);

        let sessionStat: { birthtimeMs: number; mtimeMs: number };
        try {
          const stats = await fs.stat(sessionFilePath);
          sessionStat = { birthtimeMs: stats.birthtimeMs, mtimeMs: stats.mtimeMs };
        } catch (error: unknown) {
          warnings.push(`Nie udalo sie odczytac statystyk sesji ${fileName}: ${describeError(error)}`);
          continue;
        }

        if (now - sessionStat.mtimeMs > lookbackMs) {
          // Sesja starsza niz okno "lookback" - pomijamy ja calkowicie,
          // razem z jej subagentami, zeby nie skanowac wielkiego drzewa
          // katalogow ~/.claude/projects przy kazdym odswiezeniu.
          continue;
        }

        const sessionMeta = await this.sessionMetaCache.getOrCompute(sessionFilePath, extractSessionMeta, (message) =>
          warnings.push(message)
        );
        const title = sessionMeta?.title ?? slug;
        const repo = sessionMeta?.cwd ?? slug;

        // Status wylacznie na dowodzie pozytywnym - patrz komentarz przy
        // RUNNING_STOP_REASON/CLOSED_TURN_STOP_REASONS. Wszystko poza
        // Running i WaitingForUser trafia do Idle, ktore scanner.ts i tak
        // odfiltrowuje - to jest po prostu "nie pokazuj tego".
        let sessionStatus: TaskStatus;
        const turnStillOpen =
          sessionMeta?.lastAssistantStopReason === RUNNING_STOP_REASON &&
          !sessionMeta.hasNewerQualifyingUserMessage;
        const generating = turnStillOpen && now - sessionStat.mtimeMs <= GENERATING_WINDOW_MS;
        if (turnStillOpen && (sessionMeta.lastAssistantHasUnpairedOwnToolUse || generating)) {
          sessionStatus = TaskStatus.Running;
        } else if (
          sessionMeta?.lastAssistantStopReason !== undefined &&
          CLOSED_TURN_STOP_REASONS.has(sessionMeta.lastAssistantStopReason) &&
          !sessionMeta.hasNewerQualifyingUserMessage &&
          now - sessionStat.mtimeMs <= waitingLookbackMs
        ) {
          sessionStatus = TaskStatus.WaitingForUser;
        } else {
          sessionStatus = TaskStatus.Idle;
        }

        // Licznik czasu ma pokazywac dlugosc BIEZACEJ TURY, nie wiek pliku
        // sesji - startedAt to timestamp ostatniej prawdziwej wiadomosci
        // user, z fallbackiem na birthtime/mtime, gdy nie da sie go wyznaczyc.
        // Dla WaitingForUser webview i tak liczy wyswietlany czas od
        // lastActivityAt (mtime), nie od startedAt - patrz main.js.
        const sessionStartedAt = sessionMeta?.turnStartedAtMs ?? (sessionStat.birthtimeMs || sessionStat.mtimeMs);

        tasks.push({
          id: sessionUuid,
          engine: TaskEngine.Claude,
          kind: TaskKind.Session,
          status: sessionStatus,
          title,
          repo,
          startedAt: sessionStartedAt,
          lastActivityAt: sessionStat.mtimeMs,
          transcriptPath: sessionFilePath
        });

        const sessionDir = path.join(slugPath, sessionUuid);
        const subagentResult = await this.scanSubagents(sessionDir, sessionUuid, sessionFilePath, repo, now, staleAfterMs);
        tasks.push(...subagentResult.tasks);
        warnings.push(...subagentResult.warnings);
      }
    }

    return { tasks, warnings };
  }

  private async scanSubagents(
    sessionDir: string,
    sessionUuid: string,
    sessionFilePath: string,
    repo: string,
    now: number,
    staleAfterMs: number
  ): Promise<ClaudeScanResult> {
    const warnings: string[] = [];
    const subagentsDir = path.join(sessionDir, 'subagents');
    let metaFileNames: string[];
    try {
      const entries = await fs.readdir(subagentsDir, { withFileTypes: true });
      metaFileNames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
        .map((entry) => entry.name);
    } catch {
      // Brak subagentow dla tej sesji to normalny stan, nie blad.
      return { tasks: [], warnings };
    }

    const toolResultsDir = path.join(sessionDir, 'tool-results');
    const tasks: WorkerTask[] = [];

    for (const metaFileName of metaFileNames) {
      const agentId = metaFileName.slice('agent-'.length, -'.meta.json'.length);
      const metaFilePath = path.join(subagentsDir, metaFileName);

      let meta: SubagentMeta;
      try {
        const content = await fs.readFile(metaFilePath, 'utf8');
        meta = JSON.parse(content) as SubagentMeta;
      } catch (error: unknown) {
        warnings.push(`Nie udalo sie odczytac meta agenta ${metaFileName}: ${describeError(error)}`);
        continue;
      }

      const agentJsonlPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
      let agentStat: { birthtimeMs: number; mtimeMs: number };
      try {
        const stats = await fs.stat(agentJsonlPath);
        agentStat = { birthtimeMs: stats.birthtimeMs, mtimeMs: stats.mtimeMs };
      } catch (error: unknown) {
        warnings.push(`Brak transkryptu agenta ${metaFileName}: ${describeError(error)}`);
        continue;
      }

      const parentFilePath = meta.parentAgentId
        ? path.join(subagentsDir, `agent-${meta.parentAgentId}.jsonl`)
        : sessionFilePath;

      const status = await this.resolveSubagentStatus(
        parentFilePath,
        toolResultsDir,
        agentId,
        meta.toolUseId,
        meta.stoppedByUser === true,
        agentStat.mtimeMs,
        now,
        staleAfterMs,
        (message) => warnings.push(message)
      );

      tasks.push({
        id: `${sessionUuid}:agent-${agentId}`,
        engine: TaskEngine.Claude,
        kind: TaskKind.Subagent,
        status,
        title: meta.description || meta.agentType || 'Subagent',
        // subtitle niesie sam agentType (np. "Explore", "general-purpose") -
        // model ma juz wlasne dedykowane pole WorkerTask.model, wiec nie ma
        // sensu ich laczyc jak wczesniej.
        subtitle: meta.agentType,
        repo,
        startedAt: agentStat.birthtimeMs || agentStat.mtimeMs,
        lastActivityAt: agentStat.mtimeMs,
        transcriptPath: agentJsonlPath,
        depth: meta.spawnDepth,
        parentId: meta.parentAgentId ? `${sessionUuid}:agent-${meta.parentAgentId}` : sessionUuid
      });
    }

    return { tasks, warnings };
  }

  private async resolveSubagentStatus(
    parentFilePath: string,
    toolResultsDir: string,
    agentId: string,
    toolUseId: string | undefined,
    stoppedByUser: boolean,
    lastActivityAt: number,
    now: number,
    staleAfterMs: number,
    onWarning: (message: string) => void
  ): Promise<TaskStatus> {
    const signals = await this.completionCache.getOrCompute(parentFilePath, extractCompletionSignals, onWarning);

    // 1. Sciezka asynchroniczna - kolejka pisze <task-notification> z
    //    agentId w <task-id> i ostatecznym stanem w <status>. To jedyny
    //    wiarygodny sygnal dla agentow odpalanych w tle - tool_result
    //    ich wywolania Task potwierdza tylko dispatch, nie wynik. Ma
    //    pierwszenstwo przed stoppedByUser, bo jest zapisem terminalnym
    //    samego harnessu, bardziej wiarygodnym niz flaga w meta.
    //
    //    WAZNE: notyfikacja jest autorytatywna TYLKO dopoki mtime pliku
    //    agenta nie jest od niej pozniejszy (z tolerancja zegara). Agent
    //    wznowiony przez SendMessage dopisuje transkrypt po ostatnim
    //    "completed" bez tworzenia nowej notyfikacji - jego mtime wyprzedza
    //    wtedy notyfikacje, co oznacza "wznowiony i znow pracuje", nie
    //    "trwale zakonczony".
    const notificationTimestampMs = signals?.latestNotificationTimestampMs.get(agentId);
    const notificationStatusInfo = signals?.latestNotificationStatus.get(agentId);
    if (notificationTimestampMs !== undefined && notificationStatusInfo !== undefined) {
      const stillAuthoritative = lastActivityAt <= notificationTimestampMs + NOTIFICATION_MTIME_TOLERANCE_MS;
      if (stillAuthoritative) {
        return notificationStatusInfo.status === 'completed' ? TaskStatus.Done : TaskStatus.Failed;
      }
      // mtime pliku agenta jest pozniejszy niz najpozniejsza notyfikacja o
      // wiecej niz tolerancja - agent zostal wznowiony, leci dalej do
      // kolejnych warunkow (stoppedByUser, sync tool_result, tool-results,
      // regula swiezosci).
    }

    // 2. Flaga jest terminalna - taki agent nigdy nie ma wyjsc jako Running,
    //    niezaleznie od tego, jak swiezy jest jego plik transkryptu.
    if (stoppedByUser) {
      return TaskStatus.Killed;
    }

    // 3. Sciezka synchroniczna - prawdziwy tool_result (nie marker
    //    dispatchu) na tool_use_id tego wywolania Task. Pomijana w calosci,
    //    gdy toolUseId jest nieobecny w meta (17% plikow na dysku) - to nie
    //    jest warunek niespelniony, tylko niesprawdzalny.
    if (toolUseId && signals?.syncCompletedToolUseIds.has(toolUseId)) {
      return TaskStatus.Done;
    }

    // 4. Zapasowy sygnal - plik z wynikiem narzedzia na dysku. Tak samo
    //    pomijany calkowicie bez toolUseId.
    if (toolUseId) {
      try {
        await fs.access(path.join(toolResultsDir, `${toolUseId}.txt`));
        return TaskStatus.Done;
      } catch {
        // brak pliku - przechodzimy do reguly swiezosci
      }
    }

    // 5. Zaden sygnal ukonczenia nie zadzialal. Dla subagentow nie ma PID-u
    //    do sprawdzenia zywotnosci jak przy heartbeatach - jedyny dostepny
    //    sygnal to wiek pliku transkryptu. To heurystyka, nie dowod, dlatego
    //    osobny status (Stale) zamiast udawania realnego Running na zawsze.
    if (now - lastActivityAt > staleAfterMs) {
      return TaskStatus.Stale;
    }

    return TaskStatus.Running;
  }
}

function extractCompletionSignals(content: string): CompletionSignals {
  const syncCompletedToolUseIds = new Set<string>();
  const toolUseIdPattern = /"tool_use_id":"([^"]+)"/g;
  let toolUseMatch: RegExpExecArray | null;
  while ((toolUseMatch = toolUseIdPattern.exec(content)) !== null) {
    const id = toolUseMatch[1];
    if (!id) {
      continue;
    }
    // Okno wystarczajaco duze, by objac pole "content" bezposrednio
    // nastepujace po tool_use_id, gdzie pojawia sie marker dispatchu.
    const window = content.slice(toolUseMatch.index, toolUseMatch.index + 400);
    if (!ASYNC_DISPATCH_MARKER.test(window)) {
      syncCompletedToolUseIds.add(id);
    }
  }

  const latestNotificationTimestampMs = new Map<string, number>();
  const latestNotificationStatus = new Map<string, LatestNotificationStatus>();

  for (const line of content.split('\n')) {
    if (!line || !line.includes('"type":"queue-operation"')) {
      continue;
    }
    let entry: { timestamp?: string; content?: string };
    try {
      entry = JSON.parse(line) as { timestamp?: string; content?: string };
    } catch {
      continue;
    }
    if (typeof entry.content !== 'string' || typeof entry.timestamp !== 'string') {
      continue;
    }

    const taskId = /<task-id>([^<]*)<\/task-id>/.exec(entry.content)?.[1];
    if (!taskId) {
      continue;
    }
    const timestampMs = Date.parse(entry.timestamp);
    if (Number.isNaN(timestampMs)) {
      continue;
    }

    // Czas bierzemy z KAZDEJ linii z tym task-id, statusem lub bez -
    // niektore linie queue-operation nie niosa <status> wcale.
    const currentLatestTimestamp = latestNotificationTimestampMs.get(taskId);
    if (currentLatestTimestamp === undefined || timestampMs > currentLatestTimestamp) {
      latestNotificationTimestampMs.set(taskId, timestampMs);
    }

    const status = /<status>([^<]*)<\/status>/.exec(entry.content)?.[1];
    if (status) {
      // Status bierzemy osobno - z najpozniejszej linii, ktora GO NIESIE
      // (moze byc wczesniejsza niz najpozniejsza linia w ogole).
      const currentLatestStatus = latestNotificationStatus.get(taskId);
      if (!currentLatestStatus || timestampMs > currentLatestStatus.timestampMs) {
        latestNotificationStatus.set(taskId, { status, timestampMs });
      }
    }
  }

  return { syncCompletedToolUseIds, latestNotificationTimestampMs, latestNotificationStatus };
}

interface MessageContentBlock {
  readonly type?: string;
  readonly id?: string;
  readonly tool_use_id?: string;
  readonly text?: string;
}

interface MessageLineShape {
  readonly type?: string;
  readonly timestamp?: string;
  readonly message?: {
    readonly content?: unknown;
  };
}

function extractSessionMeta(content: string): SessionMeta {
  let lastTitle: string | undefined;
  let firstCwd: string | undefined;

  // Wszystko liczone w jednym przejsciu po tresci - zero dodatkowego
  // odczytu pliku poza tym, ktory i tak juz robi FileCache.
  let lastAssistantStopReason: string | undefined;
  let lastAssistantTimestampMs: number | undefined;
  let lastAssistantToolUseIds: string[] = [];
  const toolResultIds = new Set<string>();
  // Najpozniejszy timestamp "kwalifikujacej sie" wiadomosci user (nie
  // wylacznie tool_result, nie marker przerwania) - do testu "czy jest cos
  // nowszego niz ostatni assistant".
  let latestQualifyingUserTimestampMs: number | undefined;
  // Najpozniejszy timestamp jakiejkolwiek wiadomosci user, ktora NIE jest
  // markerem przerwania - do wyznaczenia poczatku biezacej tury (startedAt).
  // Definicja celowo szersza niz "kwalifikujaca sie" powyzej (dopuszcza
  // tool_result-only), bo to inne zastosowanie - prezentacja czasu, nie
  // dowod stanu.
  let latestNonInterruptUserTimestampMs: number | undefined;

  for (const line of content.split('\n')) {
    if (!line) {
      continue;
    }

    if (line.includes('"type":"ai-title"')) {
      try {
        const parsed = JSON.parse(line) as { aiTitle?: string };
        if (typeof parsed.aiTitle === 'string' && parsed.aiTitle.length > 0) {
          lastTitle = parsed.aiTitle;
        }
      } catch {
        // Niekompletna lub uszkodzona linia jsonl - pomijamy ja.
      }
    }

    if (firstCwd === undefined && line.includes('"cwd":"')) {
      try {
        const parsed = JSON.parse(line) as { cwd?: string };
        if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) {
          firstCwd = parsed.cwd;
        }
      } catch {
        // Niekompletna lub uszkodzona linia jsonl - pomijamy ja.
      }
    }

    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) {
      continue;
    }

    let messageLine: MessageLineShape;
    try {
      messageLine = JSON.parse(line) as MessageLineShape;
    } catch {
      continue;
    }
    if (!messageLine.message) {
      continue;
    }
    const blocks = messageLine.message.content;
    const timestampMs = typeof messageLine.timestamp === 'string' ? Date.parse(messageLine.timestamp) : Number.NaN;
    const validTimestampMs = Number.isNaN(timestampMs) ? undefined : timestampMs;

    if (messageLine.type === 'assistant') {
      // Nadpisujemy przy kazdej kolejnej wiadomosci assistant - na koniec
      // petli zostaje stan OSTATNIEJ. Celowo NIE gromadzimy tool_use z
      // wczesniejszych wiadomosci - to jest istota poprawki: przerwane w
      // przeszlosci narzedzia nie moga trwale "zamrozic" sesji na Running.
      lastAssistantStopReason = (messageLine.message as { stop_reason?: string }).stop_reason;
      lastAssistantTimestampMs = validTimestampMs;
      lastAssistantToolUseIds = [];
      if (Array.isArray(blocks)) {
        for (const block of blocks as readonly MessageContentBlock[]) {
          if (block && block.type === 'tool_use' && typeof block.id === 'string') {
            lastAssistantToolUseIds.push(block.id);
          }
        }
      }
      continue;
    }

    // messageLine.type === 'user'
    let hasNonResultBlock = false;
    if (Array.isArray(blocks)) {
      for (const block of blocks as readonly MessageContentBlock[]) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          toolResultIds.add(block.tool_use_id);
        } else if (block) {
          hasNonResultBlock = true;
        }
      }
    } else if (typeof blocks === 'string') {
      hasNonResultBlock = blocks.length > 0;
    }

    const text = extractMessageText(blocks);
    const isInterrupt = isInterruptMarker(text);

    if (!isInterrupt && validTimestampMs !== undefined) {
      if (latestNonInterruptUserTimestampMs === undefined || validTimestampMs > latestNonInterruptUserTimestampMs) {
        latestNonInterruptUserTimestampMs = validTimestampMs;
      }
      if (hasNonResultBlock && (latestQualifyingUserTimestampMs === undefined || validTimestampMs > latestQualifyingUserTimestampMs)) {
        latestQualifyingUserTimestampMs = validTimestampMs;
      }
    }
  }

  const lastAssistantHasUnpairedOwnToolUse = lastAssistantToolUseIds.some((id) => !toolResultIds.has(id));
  const hasNewerQualifyingUserMessage =
    latestQualifyingUserTimestampMs !== undefined &&
    lastAssistantTimestampMs !== undefined &&
    latestQualifyingUserTimestampMs > lastAssistantTimestampMs;

  return {
    title: lastTitle,
    cwd: firstCwd,
    lastAssistantStopReason,
    lastAssistantTimestampMs,
    lastAssistantHasUnpairedOwnToolUse,
    hasNewerQualifyingUserMessage,
    turnStartedAtMs: latestNonInterruptUserTimestampMs
  };
}

function extractMessageText(blocks: unknown): string {
  if (typeof blocks === 'string') {
    return blocks;
  }
  if (Array.isArray(blocks)) {
    return (blocks as readonly MessageContentBlock[])
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
  }
  return '';
}

function isInterruptMarker(text: string): boolean {
  return text.trim().toLowerCase().startsWith(INTERRUPT_MARKER_PREFIX);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

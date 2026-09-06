// Orkiestracja skanowania: laczy heartbeaty (Spark/Codex) i sesje Claude Code
// w jedna migawke i mierzy czas skanowania. Panel pokazuje wylacznie zadania
// aktualnie wykonywane - filtr do TaskStatus.Running nakladany na koniec, po
// wyznaczeniu wszystkich statusow (Running wynika z braku sygnalu ukonczenia,
// wiec nie da sie go skrocic wczesniej).
//
// Metryki (model/effort/branch/currentActivity/tokensUsed/contextTokens) sa
// doliczane w OSOBNYM kroku PO filtrowaniu, wylacznie dla zadan, ktore
// przeszly do TaskStatus.Running - to jest dodatkowy odczyt calego pliku
// transkryptu (Claude) albo katalogu dnia rolloutow (Codex), ktorego nie da
// sie sobie pozwolic dla wszystkich przeskanowanych zadan (dzis 31 przed
// filtrem, 2 po filtrze).

import { TaskEngine, TaskKind, TaskStatus, WorkerTask } from './model.js';
import { scanHeartbeats } from './sources/heartbeats.js';
import { ClaudeSource } from './sources/claude.js';
import { computeClaudeMetrics } from './sources/claude-metrics.js';
import { resolveCodexTokensUsed } from './sources/codex-tokens.js';

export interface ScanConfig {
  readonly claudeProjectsPath: string;
  readonly workerStatusPath: string;
  readonly codexSessionsPath: string;
  readonly claudeLookbackHours: number;
  readonly pollIntervalMs: number;
  readonly subagentStaleAfterMinutes: number;
  readonly contextWindowTokens: number;
  readonly waitingLookbackMinutes: number;
}

// Widocznosc pojedynczego LISCIA (subagent, worker) bez zmian od
// poprzednich rund: tylko Running. Sesje maja dodatkowa sciezke widocznosci
// (patrz resolveVisibleSessionIds) - moga byc widoczne przez WaitingForUser
// LUB przez posiadanie widocznego dziecka, nawet gdy same nie pracuja.
const LEAF_VISIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set([TaskStatus.Running]);
const SESSION_OWN_VISIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set([TaskStatus.Running, TaskStatus.WaitingForUser]);

export interface ScanLogger {
  warn(message: string): void;
}

export interface ScanResult {
  readonly tasks: readonly WorkerTask[];
  readonly scannedAt: number;
  readonly durationMs: number;
}

const SLOW_SCAN_THRESHOLD_MS = 2000;

export class Scanner {
  private readonly claudeSource = new ClaudeSource();

  public async scan(config: ScanConfig, logger: ScanLogger): Promise<ScanResult> {
    const startedAt = Date.now();

    const [heartbeatResult, claudeResult] = await Promise.all([
      scanHeartbeats(config.workerStatusPath),
      this.claudeSource.scan(
        config.claudeProjectsPath,
        config.claudeLookbackHours,
        config.subagentStaleAfterMinutes,
        config.waitingLookbackMinutes
      )
    ]);

    for (const warning of [...heartbeatResult.warnings, ...claudeResult.warnings]) {
      logger.warn(warning);
    }

    const allTasks = [...heartbeatResult.tasks, ...claudeResult.tasks];
    const visibleTasks = this.resolveVisibleTasks(allTasks);

    const enrichedTasks = await Promise.all(visibleTasks.map((task) => this.enrichTask(task, config)));

    // Na koniec kazdego pelnego skanu usun z cache wpisy, o ktore w tym
    // cyklu nikt nie pytal (np. sesja wypadla z okna lookback) - inaczej
    // mapa rosnie bez ograniczen przy dlugo dzialajacym VS Code.
    this.claudeSource.pruneCaches();

    const scannedAt = Date.now();
    const durationMs = scannedAt - startedAt;
    if (durationMs > SLOW_SCAN_THRESHOLD_MS) {
      logger.warn(`Pelne skanowanie trwalo ${durationMs} ms, powyzej progu ${SLOW_SCAN_THRESHOLD_MS} ms.`);
    }

    return { tasks: enrichedTasks, scannedAt, durationMs };
  }

  // Sesja jest widoczna, gdy jest Running/WaitingForUser SAMA, ALBO ma co
  // najmniej jedno widoczne dziecko (subagent w jej drzewie, badz worker
  // Spark/Codex, ktorego sessionId na nia wskazuje). Ten drugi warunek jest
  // kluczowy: uzytkownik rozsyla workerow i wtedy sama konwersacja czeka -
  // grupa nie moze przez to zniknac razem z dziecmi. Workery/subagenci maja
  // wlasna, niezmienioną regule (tylko Running) - to tutaj sie nie zmienia,
  // zmienia sie wylacznie to, CZY SESJA (rodzic) trafia do migawki.
  private resolveVisibleTasks(allTasks: readonly WorkerTask[]): WorkerTask[] {
    const sessions = allTasks.filter((task) => task.kind === TaskKind.Session);
    const visibleSubagents = allTasks.filter((task) => task.kind === TaskKind.Subagent && LEAF_VISIBLE_STATUSES.has(task.status));
    const visibleWorkers = allTasks.filter((task) => task.kind === TaskKind.Worker && LEAF_VISIBLE_STATUSES.has(task.status));

    // Subagent id ma zawsze ksztalt "<sessionUuid>:agent-<agentId>" -
    // sessionUuid (korzen drzewa) jest wiec pierwszym segmentem, niezaleznie
    // od glebokosci zagniezdzenia.
    const sessionIdsWithVisibleSubagent = new Set(visibleSubagents.map((task) => task.id.split(':')[0]));
    const sessionIdsWithVisibleWorker = new Set(
      visibleWorkers.filter((task) => task.sessionId !== undefined).map((task) => task.sessionId as string)
    );

    const visibleSessionIds = new Set<string>();
    for (const session of sessions) {
      const ownVisible = SESSION_OWN_VISIBLE_STATUSES.has(session.status);
      const hasVisibleChild = sessionIdsWithVisibleSubagent.has(session.id) || sessionIdsWithVisibleWorker.has(session.id);
      if (ownVisible || hasVisibleChild) {
        visibleSessionIds.add(session.id);
      }
    }

    const visibleSessions = sessions.filter((session) => visibleSessionIds.has(session.id));
    // Grupa zapasowa "BEZ PRZYPISANIA": worker bez sessionId, albo z
    // sessionId, ktory nie odpowiada zadnej WIDOCZNEJ sesji (np. sesja
    // sama nie pracuje i nie ma innych widocznych dzieci) - bez tej grupy
    // takie rekordy znikalyby bez sladu.
    const attachedWorkers = visibleWorkers.filter((task) => task.sessionId !== undefined && visibleSessionIds.has(task.sessionId));
    const unassignedWorkers = visibleWorkers.filter((task) => task.sessionId === undefined || !visibleSessionIds.has(task.sessionId));

    return [...visibleSessions, ...visibleSubagents, ...attachedWorkers, ...unassignedWorkers];
  }

  private async enrichTask(task: WorkerTask, config: ScanConfig): Promise<WorkerTask> {
    if (task.engine === TaskEngine.Claude) {
      if (!task.transcriptPath) {
        return task;
      }
      const metrics = await computeClaudeMetrics(task.transcriptPath);
      return {
        ...task,
        model: metrics.model,
        effort: metrics.effort,
        branch: metrics.branch,
        currentActivity: metrics.currentActivity,
        tokensUsed: metrics.tokensUsed,
        contextTokens: metrics.contextTokens,
        // Transkrypt nie niesie rozmiaru okna kontekstu - bierzemy go z
        // konfiguracji. Zawsze ustawiony dla Claude; karta i tak pokazuje
        // pasek tylko, gdy contextTokens tez jest znane.
        contextWindow: config.contextWindowTokens
      };
    }

    if (task.engine === TaskEngine.Codex) {
      const tokensUsed = await resolveCodexTokensUsed(config.codexSessionsPath, task.repo, task.startedAt ?? Number.NaN);
      return { ...task, tokensUsed };
    }

    // Spark: model/effort juz ustawione w heartbeats.ts, tokensUsed i
    // contextTokens zostaja undefined - Spark tych danych nie udostepnia.
    return task;
  }
}

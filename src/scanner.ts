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

import { TaskEngine, TaskStatus, WorkerTask } from './model.js';
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

// Panel pokazuje zadania w toku ORAZ sesje czekajace na uzytkownika - to
// jedyne dwa statusy, ktore maja prawo trafic do webview.
const VISIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set([TaskStatus.Running, TaskStatus.WaitingForUser]);

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
    const visibleTasks = allTasks.filter((task) => VISIBLE_STATUSES.has(task.status));

    const enrichedTasks = await Promise.all(visibleTasks.map((task) => this.enrichTask(task, config)));

    const scannedAt = Date.now();
    const durationMs = scannedAt - startedAt;
    if (durationMs > SLOW_SCAN_THRESHOLD_MS) {
      logger.warn(`Pelne skanowanie trwalo ${durationMs} ms, powyzej progu ${SLOW_SCAN_THRESHOLD_MS} ms.`);
    }

    return { tasks: enrichedTasks, scannedAt, durationMs };
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

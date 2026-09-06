// Zrodlo 1: workery zewnetrzne (Spark, Codex) zapisywane jako pliki
// heartbeatu przez osobny wrapper PowerShell. Ten modul tylko czyta.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TaskEngine, TaskKind, TaskStatus, WorkerTask, HeartbeatRecord } from '../model.js';
import { isProcessAlive } from '../util/pid.js';

export interface HeartbeatScanResult {
  readonly tasks: readonly WorkerTask[];
  readonly warnings: readonly string[];
}

const FINISHED_HEARTBEAT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.Done,
  TaskStatus.Failed,
  TaskStatus.Killed,
  TaskStatus.Stale
]);

// Uzywane przez komende "Wyczysc zakonczone" - zwraca pelne sciezki plikow
// heartbeatu, ktorych rozwiazany status (z weryfikacja PID) jest zakonczony.
// Nigdy nie zwraca pliku ze statusem "running".
export async function listFinishedHeartbeatFiles(workerStatusDir: string): Promise<string[]> {
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(workerStatusDir);
  } catch {
    return [];
  }

  const jsonFiles = fileNames.filter((name) => name.toLowerCase().endsWith('.json'));
  const finishedPaths: string[] = [];

  for (const fileName of jsonFiles) {
    const filePath = path.join(workerStatusDir, fileName);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const record = JSON.parse(content) as HeartbeatRecord;
      const status = await resolveStatus(record);
      if (FINISHED_HEARTBEAT_STATUSES.has(status)) {
        finishedPaths.push(filePath);
      }
    } catch {
      // Uszkodzony lub nieczytelny plik pomijamy - nie kasujemy niczego
      // czego nie potrafimy jednoznacznie sklasyfikowac.
    }
  }

  return finishedPaths;
}

export async function scanHeartbeats(workerStatusDir: string): Promise<HeartbeatScanResult> {
  const warnings: string[] = [];
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(workerStatusDir);
  } catch {
    // Katalog moze nie istniec, dopoki wrapper nie zapisze pierwszego
    // heartbeatu - to nie jest blad, sekcja ma byc po prostu pusta.
    return { tasks: [], warnings };
  }

  const jsonFiles = fileNames.filter((name) => name.toLowerCase().endsWith('.json'));
  const tasks: WorkerTask[] = [];

  for (const fileName of jsonFiles) {
    const filePath = path.join(workerStatusDir, fileName);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const record = JSON.parse(content) as HeartbeatRecord;
      const task = await toWorkerTask(record);
      if (task) {
        tasks.push(task);
      } else {
        warnings.push(`Pominieto plik heartbeatu o nieznanym silniku: ${fileName}`);
      }
    } catch (error: unknown) {
      warnings.push(`Nie udalo sie odczytac heartbeatu ${fileName}: ${describeError(error)}`);
    }
  }

  return { tasks, warnings };
}

async function toWorkerTask(record: HeartbeatRecord): Promise<WorkerTask | undefined> {
  const engine = parseEngine(record.engine);
  if (!engine) {
    return undefined;
  }

  const status = await resolveStatus(record);
  const startedAt = parseDate(record.startedAt);
  const finishedAt = parseDate(record.finishedAt ?? undefined);
  const modelLabel = record.model ?? undefined;
  const effortLabel = record.effort ?? undefined;
  const subtitle = [modelLabel, effortLabel].filter((part): part is string => Boolean(part)).join(' - ') || undefined;

  return {
    id: record.id,
    engine,
    kind: TaskKind.Worker,
    status,
    title: record.title,
    subtitle,
    repo: record.repo ?? undefined,
    pid: record.pid,
    startedAt,
    finishedAt,
    lastActivityAt: finishedAt ?? startedAt,
    exitCode: record.exitCode ?? undefined,
    logPath: record.logPath ?? undefined,
    transcriptPath: record.briefPath ?? undefined,
    // model/effort sa juz w rekordzie heartbeatu - zero dodatkowego I/O,
    // wiec ustawiamy je od razu, bez czekania na etap wzbogacania po filtrze.
    // tokensUsed/contextTokens dla Sparka zostaja undefined - sprawdzony
    // pelny strumien "muse exec --json" nie niesie zadnego pola tokenowego.
    // Dla Codexa tokensUsed doliczany jest pozniej (patrz codex-tokens.ts),
    // wylacznie dla zadan po filtrze Running.
    model: modelLabel,
    effort: effortLabel
  };
}

async function resolveStatus(record: HeartbeatRecord): Promise<TaskStatus> {
  const rawStatus = parseStatus(record.status);
  if (rawStatus !== TaskStatus.Running) {
    return rawStatus;
  }

  // Rekord twierdzi, ze proces dziala - zweryfikuj to po PID, zeby wykryc
  // przebiegi osierocone (np. po awarii maszyny lub zabiciu procesu poza
  // rozszerzeniem, bez aktualizacji pliku heartbeatu).
  if (typeof record.pid === 'number' && Number.isFinite(record.pid)) {
    return isProcessAlive(record.pid) ? TaskStatus.Running : TaskStatus.Stale;
  }
  return TaskStatus.Running;
}

function parseEngine(value: string): TaskEngine | undefined {
  if (value === TaskEngine.Spark) {
    return TaskEngine.Spark;
  }
  if (value === TaskEngine.Codex) {
    return TaskEngine.Codex;
  }
  return undefined;
}

function parseStatus(value: string): TaskStatus {
  switch (value) {
    case TaskStatus.Running:
      return TaskStatus.Running;
    case TaskStatus.Done:
      return TaskStatus.Done;
    case TaskStatus.Failed:
      return TaskStatus.Failed;
    case TaskStatus.Killed:
      return TaskStatus.Killed;
    default:
      return TaskStatus.Failed;
  }
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
// Nigdy nie zwraca pliku ze statusem "running" ani z NIEZNANYM statusem -
// nie kasujemy niczego, czego nie potrafimy jednoznacznie sklasyfikowac.
// Ostrzezenia o takich plikach i tak trafiaja do OutputChannel przy okazji
// zwyklego scanHeartbeats(), wiec nie duplikujemy logowania tutaj.
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
      if (validateRecordShape(record) !== undefined) {
        continue;
      }
      const status = await resolveStatus(record);
      if (status !== undefined && FINISHED_HEARTBEAT_STATUSES.has(status)) {
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

      const shapeError = validateRecordShape(record);
      if (shapeError !== undefined) {
        warnings.push(`Pominieto heartbeat ${fileName}: ${shapeError} - plik pozostaje nietkniety.`);
        continue;
      }

      const task = await toWorkerTask(record);
      if (task) {
        tasks.push(task);
      } else {
        warnings.push(`Pominieto plik heartbeatu ${fileName}: nierozpoznany silnik lub status - plik pozostaje nietkniety.`);
      }
    } catch (error: unknown) {
      warnings.push(`Nie udalo sie odczytac heartbeatu ${fileName}: ${describeError(error)}`);
    }
  }

  return { tasks, warnings };
}

// Waliduje obecnosc i typ pol WYMAGANYCH do bezpiecznego zbudowania
// WorkerTask (id, engine, status, title, startedAt - pid NIE jest
// wymagany, worker moze nie miec jeszcze PID-u). Rekord bez tych pol nie
// jest "ratowany" wartosciami zastepczymi - jest pomijany w calosci, zeby
// nie trafil do webview jako zadanie z polami "undefined" (dataset.id
// literalnie "undefined", sortowanie po NaN, akcje Log/Zabij przestajace
// dzialac).
function validateRecordShape(record: HeartbeatRecord): string | undefined {
  if (typeof record.id !== 'string' || record.id.length === 0) {
    return 'brak pola id';
  }
  if (typeof record.engine !== 'string' || record.engine.length === 0) {
    return 'brak pola engine';
  }
  if (typeof record.status !== 'string' || record.status.length === 0) {
    return 'brak pola status';
  }
  if (typeof record.title !== 'string' || record.title.length === 0) {
    return 'brak pola title';
  }
  if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) {
    return 'brak pola startedAt';
  }
  return undefined;
}

async function toWorkerTask(record: HeartbeatRecord): Promise<WorkerTask | undefined> {
  const engine = parseEngine(record.engine);
  if (!engine) {
    return undefined;
  }

  const status = await resolveStatus(record);
  if (status === undefined) {
    // Status nierozpoznany (dryf schematu, literowka, czesciowy zapis) -
    // NIGDY nie zgadujemy najblizszego dopasowania. Rekord znika z
    // prezentacji, plik zostaje nietkniety na dysku.
    return undefined;
  }

  const startedAt = parseDate(record.startedAt);
  const finishedAt = parseDate(record.finishedAt ?? undefined);
  const modelLabel = record.model ?? undefined;
  const effortLabel = record.effort ?? undefined;
  const subtitle = [modelLabel, effortLabel].filter((part): part is string => Boolean(part)).join(' - ') || undefined;
  const pid = typeof record.pid === 'number' && Number.isFinite(record.pid) ? record.pid : undefined;

  return {
    id: record.id,
    engine,
    kind: TaskKind.Worker,
    status,
    title: record.title,
    subtitle,
    repo: record.repo ?? undefined,
    pid,
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
    effort: effortLabel,
    // Opcjonalne - starsze rekordy i workery odpalone poza Claude Code go
    // nie maja (worker-run.ps1 wypelnia je z CLAUDE_CODE_SESSION_ID). Brak
    // dopasowania do zadnej widocznej sesji ladowuje do grupy zapasowej.
    sessionId: record.sessionId ?? undefined
  };
}

// Zwraca undefined dla statusu NIEROZPOZNANEGO - jawnie odrozniony od
// kazdego ze znanych statusow, zeby nie dalo sie go pomylic z "Failed" i
// przypadkiem zakwalifikowac jako zakonczony/do skasowania.
async function resolveStatus(record: HeartbeatRecord): Promise<TaskStatus | undefined> {
  const rawStatus = parseStatus(record.status);
  if (rawStatus === undefined) {
    return undefined;
  }
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

// Tylko statusy JAWNIE rozpoznane - kazda inna wartosc (dryf schematu,
// literowka, czesciowy zapis) zwraca undefined, nigdy domyslne "Failed".
function parseStatus(value: string): TaskStatus | undefined {
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
      return undefined;
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

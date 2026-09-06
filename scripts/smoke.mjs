// Jednorazowy skrypt do testowania skanera bez uruchamiania VS Code.
// Buduje scanner.ts oraz oba zrodla osobno (przez esbuild do tymczasowego
// katalogu CJS), importuje je i odpala prawdziwe skanowanie na dysku
// uzytkownika - raz bez filtra (zeby pokazac pelny rozklad statusow), raz
// przez Scanner.scan() (ktory filtruje migawke do TaskStatus.Running,
// zgodnie z zakresem panelu "tylko zadania aktualnie wykonywane").
//
// Uzycie:
//   node scripts/smoke.mjs [--lookback-hours=N] [--subagent-stale-after-minutes=N]
//                           [--projects-path=P] [--worker-status-path=P]

import * as esbuild from 'esbuild';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const tempOutDir = path.join(repoRoot, 'dist', 'smoke-build');

const args = parseArgs(process.argv.slice(2));

async function main() {
  await esbuild.build({
    entryPoints: {
      scanner: path.join(repoRoot, 'src', 'scanner.ts'),
      heartbeats: path.join(repoRoot, 'src', 'sources', 'heartbeats.ts'),
      claude: path.join(repoRoot, 'src', 'sources', 'claude.ts')
    },
    bundle: true,
    outdir: tempOutDir,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent'
  });

  const bust = `?t=${Date.now()}`;
  const { Scanner } = await import(pathToFileURL(path.join(tempOutDir, 'scanner.js')).href + bust);
  const { scanHeartbeats } = await import(pathToFileURL(path.join(tempOutDir, 'heartbeats.js')).href + bust);
  const { ClaudeSource } = await import(pathToFileURL(path.join(tempOutDir, 'claude.js')).href + bust);

  const config = {
    claudeProjectsPath: args['projects-path'] || path.join(os.homedir(), '.claude', 'projects'),
    workerStatusPath: args['worker-status-path'] || path.join(os.homedir(), '.claude', 'worker-status'),
    codexSessionsPath: args['codex-sessions-path'] || path.join(os.homedir(), '.codex', 'sessions'),
    claudeLookbackHours: Number(args['lookback-hours'] ?? 24),
    pollIntervalMs: 5000,
    subagentStaleAfterMinutes: Number(args['subagent-stale-after-minutes'] ?? 15),
    contextWindowTokens: Number(args['context-window-tokens'] ?? 1000000),
    waitingLookbackMinutes: Number(args['waiting-lookback-minutes'] ?? 120)
  };

  const logger = {
    warn: (message) => console.warn(`[OSTRZEZENIE] ${message}`)
  };

  console.log('--- Konfiguracja ---');
  console.log(JSON.stringify(config, null, 2));

  // Przebieg bez filtra - te same dwa zrodla, wywolane bezposrednio, zeby
  // pokazac PELNY rozklad statusow sprzed przyciecia do Running.
  const [heartbeatResult, claudeResult] = await Promise.all([
    scanHeartbeats(config.workerStatusPath),
    new ClaudeSource().scan(
      config.claudeProjectsPath,
      config.claudeLookbackHours,
      config.subagentStaleAfterMinutes,
      config.waitingLookbackMinutes
    )
  ]);
  const tasksBeforeFilter = [...heartbeatResult.tasks, ...claudeResult.tasks];

  // Przebieg przez Scanner - to jest dokladnie to, co dostaje webview.
  const scanner = new Scanner();
  const started = Date.now();
  const result = await scanner.scan(config, logger);
  const wallClockMs = Date.now() - started;

  console.log('\n--- Przed filtrem (wszystkie statusy) ---');
  console.log(`Znaleziono zadan: ${tasksBeforeFilter.length}`);
  const statusCounts = countBy(tasksBeforeFilter, (task) => task.status);
  for (const [status, count] of statusCounts) {
    console.log(`  ${status}: ${count}`);
  }

  console.log('\n--- Po filtrze (Running lub WaitingForUser - to trafia do webview) ---');
  console.log(`Znaleziono zadan: ${result.tasks.length}`);
  const statusCountsAfter = countBy(result.tasks, (task) => task.status);
  for (const [status, count] of statusCountsAfter) {
    console.log(`  ${status}: ${count}`);
  }
  const unexpectedAfterFilter = result.tasks.filter((task) => task.status !== 'running' && task.status !== 'waiting_for_user');
  console.log(`Zadania o statusie innym niz running/waiting_for_user w migawce po filtrze: ${unexpectedAfterFilter.length}`);

  console.log(`\nCzas skanowania (wewnetrzny, scanner.durationMs): ${result.durationMs} ms`);
  console.log(`Czas skanowania (mierzony z zewnatrz, wall clock): ${wallClockMs} ms`);

  console.log('\n--- Drzewo (grupowanie po zadaniach, nie po silnikach) ---');
  printTree(result.tasks);

  await fs.rm(tempOutDir, { recursive: true, force: true });
}

// Odtwarza dokladnie ten sam model grupowania co media/main.js: korzen to
// sesja Claude, dziecmi sa jej subagenci (parentId) ORAZ workery Spark/Codex
// dopiete przez sessionId - a workery bez dopasowania trafiaja na koniec do
// "BEZ PRZYPISANIA".
function printTree(tasks) {
  const sessions = tasks.filter((t) => t.kind === 'session');
  const subagents = tasks.filter((t) => t.kind === 'subagent');
  const workers = tasks.filter((t) => t.kind === 'worker');
  const sessionIds = new Set(sessions.map((t) => t.id));
  const attachedWorkers = workers.filter((t) => t.sessionId && sessionIds.has(t.sessionId));
  const unassignedWorkers = workers.filter((t) => !t.sessionId || !sessionIds.has(t.sessionId));

  const subagentsByParent = groupBy(subagents, (t) => t.parentId);
  const workersBySession = groupBy(attachedWorkers, (t) => t.sessionId);

  const printNode = (task, depth) => {
    const indent = '  '.repeat(depth);
    console.log(`${indent}[${task.kind}] ${task.status} | ${task.title} | id=${task.id}${task.sessionId ? ` | sessionId=${task.sessionId}` : ''}`);
    console.log(`${indent}    metaLine="${buildMetaLine(task)}"`);
  };

  for (const session of sessions) {
    printNode(session, 0);
    const children = [...(subagentsByParent.get(session.id) ?? []), ...(workersBySession.get(session.id) ?? [])];
    printChildren(children, subagentsByParent, printNode, 1);
  }

  if (unassignedWorkers.length > 0) {
    console.log('[BEZ PRZYPISANIA]');
    for (const task of unassignedWorkers) {
      printNode(task, 1);
    }
  }
}

function printChildren(children, subagentsByParent, printNode, depth) {
  for (const task of children) {
    printNode(task, depth);
    const grandchildren = subagentsByParent.get(task.id);
    if (grandchildren) {
      printChildren(grandchildren, subagentsByParent, printNode, depth + 1);
    }
  }
}

// Kopia logiki main.js (silnik + dedup + model + effort + reszta), do
// weryfikacji z poziomu Node bez DOM.
function abbreviateModel(model) {
  if (!model) return undefined;
  const claudeMatch = /claude-(opus|sonnet|haiku|fable)/i.exec(model);
  if (claudeMatch) return claudeMatch[1].toLowerCase();
  const sparkMatch = /muse-spark-([0-9.]+)/i.exec(model);
  if (sparkMatch) return `spark-${sparkMatch[1]}`;
  const gptMatch = /gpt-[\d.]+-(luna|terra|sol|astra)/i.exec(model);
  if (gptMatch) return gptMatch[1].toLowerCase();
  return model.length > 14 ? `${model.slice(0, 14)}…` : model;
}

function formatTokenCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  let text = (n / 1000000).toFixed(1);
  if (text.endsWith('.0')) text = text.slice(0, -2);
  return `${text}M`;
}

function basename(value) {
  const parts = value.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : value;
}

function buildMetaLine(task) {
  const modelAbbrev = abbreviateModel(task.model);
  const showEngineLabel = !(modelAbbrev && modelAbbrev.toLowerCase().startsWith(task.engine.toLowerCase()));
  const parts = [];
  if (showEngineLabel) parts.push(task.engine);
  const primary = [];
  if (task.kind === 'subagent' && task.subtitle) primary.push(task.subtitle);
  if (modelAbbrev) primary.push(modelAbbrev);
  if (primary.length > 0) parts.push(primary.join(' · '));
  const secondary = [];
  if (task.effort) secondary.push(task.effort);
  if (task.repo) secondary.push(basename(task.repo));
  if (task.branch) secondary.push(task.branch);
  if (task.pid) secondary.push(`PID ${task.pid}`);
  if (task.currentActivity) secondary.push(task.currentActivity);
  const hasContext = typeof task.contextTokens === 'number' && typeof task.contextWindow === 'number' && task.contextWindow > 0;
  if (hasContext) secondary.push(`${formatTokenCount(task.contextTokens)}/${formatTokenCount(task.contextWindow)}`);
  if (typeof task.tokensUsed === 'number') secondary.push(formatTokenCount(task.tokensUsed));
  if (secondary.length > 0) parts.push(secondary.join(' · '));
  return parts.join(' · ');
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(item);
  }
  return map;
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function parseArgs(argv) {
  const result = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

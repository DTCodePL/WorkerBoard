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

  const byEngine = groupBy(result.tasks, (task) => task.engine);
  for (const [engine, tasks] of byEngine) {
    console.log(`\n=== ${engine.toUpperCase()} (${tasks.length}) ===`);
    for (const task of tasks) {
      const indent = '  '.repeat(task.depth ?? 0);
      console.log(
        `${indent}[${task.kind}] ${task.status} | ${task.title} | agentType=${task.subtitle ?? '-'} | repo=${task.repo ?? '-'} | pid=${task.pid ?? '-'} | id=${task.id}`
      );
      console.log(
        `${indent}    model=${task.model ?? '-'} effort=${task.effort ?? '-'} branch=${task.branch ?? '-'} currentActivity=${task.currentActivity ?? '-'} tokensUsed=${task.tokensUsed ?? '-'} contextTokens=${task.contextTokens ?? '-'} contextWindow=${task.contextWindow ?? '-'}`
      );
    }
  }

  await fs.rm(tempOutDir, { recursive: true, force: true });
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

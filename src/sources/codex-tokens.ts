// Powiazanie rekordu heartbeatu Codexa z jego plikiem rolloutu i wyciagniecie
// skumulowanego zuzycia tokenow. Uruchamiane WYLACZNIE dla zadan Codex, ktore
// juz przeszly filtr Running - katalog dnia bywa skanowany co najwyzej raz na
// takie zadanie, nigdy rekurencyjnie po calym ~/.codex/sessions.
//
// WAZNE: katalog dnia (RRRR/MM/DD) jest nazwany wedlug CZASU LOKALNEGO
// maszyny, nie UTC - zweryfikowane empirycznie na rollout z payload.timestamp
// "2026-08-13T22:04:42Z" (UTC) lezacym w katalogu 2026/08/14 (lokalnie
// UTC+2, wiec po polnocy). Uzycie skladowych UTC dawaloby zly dzien dla
// sesji zaczynajacych sie pozno wieczorem.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MATCH_WINDOW_BEFORE_MS = 5000;
const MATCH_WINDOW_AFTER_MS = 30000;
// Pierwsza linia rolloutu (session_meta) niesie caly base_instructions.text
// Codexa - potrafi byc dluga, ale 64 KB z duzym zapasem pokrywa jedna linie
// jsonl. Tani pre-filtr: czytamy tylko tyle, zeby ocenic cwd/timestamp bez
// wciagania calego (potencjalnie wielomegabajtowego) pliku rolloutu.
const HEADER_PROBE_BYTES = 64 * 1024;

interface RolloutHeader {
  readonly filePath: string;
  readonly cwd?: string;
  readonly timestampMs?: number;
}

export async function resolveCodexTokensUsed(
  codexSessionsRoot: string,
  repo: string | undefined,
  startedAtMs: number
): Promise<number | undefined> {
  if (!repo || !Number.isFinite(startedAtMs)) {
    return undefined;
  }

  const dayDir = dayDirectoryFor(codexSessionsRoot, startedAtMs);
  let fileNames: string[];
  try {
    const entries = await fs.readdir(dayDir, { withFileTypes: true });
    fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }

  const windowStart = startedAtMs - MATCH_WINDOW_BEFORE_MS;
  const windowEnd = startedAtMs + MATCH_WINDOW_AFTER_MS;
  const normalizedRepo = repo.toLowerCase();

  let best: RolloutHeader | undefined;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (const fileName of fileNames) {
    const filePath = path.join(dayDir, fileName);
    const header = await readRolloutHeader(filePath);
    if (!header || header.cwd === undefined || header.timestampMs === undefined) {
      continue;
    }
    if (header.cwd.toLowerCase() !== normalizedRepo) {
      continue;
    }
    if (header.timestampMs < windowStart || header.timestampMs > windowEnd) {
      continue;
    }
    const diff = Math.abs(header.timestampMs - startedAtMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = header;
    }
  }

  if (!best) {
    return undefined;
  }

  // Pelny odczyt robimy wylacznie dla jednego dopasowanego pliku - to jest
  // jedyne miejsce, gdzie faktycznie potrzebujemy calej tresci (ostatni
  // token_usage_record moze byc gdziekolwiek w pliku).
  let fullContent: string;
  try {
    fullContent = await fs.readFile(best.filePath, 'utf8');
  } catch {
    return undefined;
  }

  return extractLastThreadTokenUsage(fullContent);
}

function dayDirectoryFor(codexSessionsRoot: string, epochMs: number): string {
  const date = new Date(epochMs);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return path.join(codexSessionsRoot, year, month, day);
}

async function readRolloutHeader(filePath: string): Promise<RolloutHeader | undefined> {
  const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
  let bytesRead: number;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    ({ bytesRead } = await handle.read(buffer, 0, HEADER_PROBE_BYTES, 0));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }

  const probe = buffer.toString('utf8', 0, bytesRead);
  const firstNewline = probe.indexOf('\n');
  if (firstNewline === -1) {
    // Pierwsza linia nie miesci sie w probie - odrzucamy kandydata zamiast
    // doczytywac wiecej; przy typowych rolloutach to sie nie zdarza.
    return undefined;
  }
  const firstLine = probe.slice(0, firstNewline);

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { cwd?: string; timestamp?: string };
    };
    if (parsed.type !== 'session_meta' || !parsed.payload) {
      return { filePath };
    }
    const cwd = typeof parsed.payload.cwd === 'string' ? parsed.payload.cwd : undefined;
    const parsedTimestamp = typeof parsed.payload.timestamp === 'string' ? Date.parse(parsed.payload.timestamp) : Number.NaN;
    const timestampMs = Number.isNaN(parsedTimestamp) ? undefined : parsedTimestamp;
    return { filePath, cwd, timestampMs };
  } catch {
    return { filePath };
  }
}

function extractLastThreadTokenUsage(content: string): number | undefined {
  let lastTotal: number | undefined;
  for (const line of content.split('\n')) {
    if (!line || !line.includes('"type":"token_usage_record"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: { thread_token_usage?: { total_tokens?: number } };
      };
      const total = parsed.payload?.thread_token_usage?.total_tokens;
      if (typeof total === 'number' && Number.isFinite(total)) {
        lastTotal = total;
      }
    } catch {
      // Niekompletna lub uszkodzona linia jsonl - pomijamy ja.
    }
  }
  return lastTotal;
}

// Metryki (model, effort, branch, biezaca aktywnosc, tokeny) wyciagane z
// TEGO SAMEGO transkryptu jsonl, ktory sluzy do wyznaczenia statusu -
// dziala identycznie dla pliku sesji glownej i dla pliku subagenta, bo oba
// maja ten sam ksztalt linii.
//
// WYDAJNOSC: wywoluj wylacznie dla zadan, ktore juz przeszly filtr Running
// (patrz scanner.ts) - to jest pelny, dodatkowy odczyt calego pliku, ktorego
// nie robimy przy samym skanowaniu statusu.

import * as fs from 'node:fs/promises';

const SYNTHETIC_MODEL_MARKER = '<synthetic>';

export interface ClaudeMetrics {
  readonly model?: string;
  readonly effort?: string;
  readonly branch?: string;
  readonly currentActivity?: string;
  readonly tokensUsed?: number;
  readonly contextTokens?: number;
}

interface UsageShape {
  readonly input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly output_tokens?: number;
}

interface ContentBlockShape {
  readonly type?: string;
  readonly name?: string;
}

interface AssistantLineShape {
  readonly type?: string;
  readonly effort?: string;
  readonly gitBranch?: string;
  readonly message?: {
    readonly model?: string;
    readonly usage?: UsageShape;
    readonly content?: readonly ContentBlockShape[];
  };
}

export async function computeClaudeMetrics(transcriptPath: string): Promise<ClaudeMetrics> {
  let content: string;
  try {
    content = await fs.readFile(transcriptPath, 'utf8');
  } catch {
    return {};
  }

  let model: string | undefined;
  let effort: string | undefined;
  let branch: string | undefined;
  let currentActivity: string | undefined;
  let tokensUsedSum = 0;
  let sawAnyUsage = false;
  let lastUsage: UsageShape | undefined;

  for (const line of content.split('\n')) {
    if (!line) {
      continue;
    }
    let obj: AssistantLineShape;
    try {
      obj = JSON.parse(line) as AssistantLineShape;
    } catch {
      continue;
    }

    // effort i gitBranch sa polami najwyzszego poziomu, niezaleznie od typu
    // linii - bierzemy ostatnie napotkane wystapienie.
    if (typeof obj.effort === 'string') {
      effort = obj.effort;
    }
    if (typeof obj.gitBranch === 'string') {
      branch = obj.gitBranch;
    }

    if (obj.type !== 'assistant' || !obj.message) {
      continue;
    }

    const lineModel = obj.message.model;
    if (typeof lineModel === 'string' && lineModel !== SYNTHETIC_MODEL_MARKER) {
      model = lineModel;
    }

    const usage = obj.message.usage;
    if (usage) {
      lastUsage = usage;
      sawAnyUsage = true;
      tokensUsedSum += numberOr0(usage.input_tokens) + numberOr0(usage.cache_creation_input_tokens) + numberOr0(usage.output_tokens);
      // cache_read_input_tokens celowo pomijany - to ten sam kontekst
      // odczytywany w kolko co ture, wliczenie zawyzyloby sume o rzad wielkosci.
    }

    const blocks = obj.message.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && block.type === 'tool_use' && typeof block.name === 'string') {
          currentActivity = block.name;
        }
      }
    }
  }

  const contextTokens = lastUsage
    ? numberOr0(lastUsage.input_tokens) + numberOr0(lastUsage.cache_creation_input_tokens) + numberOr0(lastUsage.cache_read_input_tokens)
    : undefined;

  return {
    model,
    effort,
    branch,
    currentActivity,
    tokensUsed: sawAnyUsage ? tokensUsedSum : undefined,
    contextTokens
  };
}

function numberOr0(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

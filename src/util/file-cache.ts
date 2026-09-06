// Cache tresci plikow kluczowany sciezka, wazny dopoki mtime i rozmiar
// pliku sie nie zmienia. Uzywany m.in. do przechowania Set<string> z
// wystapieniami tool_use_id wyciagnietymi z pliku rodzica sesji Claude,
// zeby nie parsowac wielomegabajtowego jsonl przy kazdym ticku skanera.

import * as fs from 'node:fs/promises';

interface CacheEntry<T> {
  readonly mtimeMs: number;
  readonly size: number;
  readonly value: T;
}

export class FileCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  public async getOrCompute(filePath: string, compute: (content: string) => T): Promise<T | undefined> {
    let stat: { mtimeMs: number; size: number };
    try {
      const stats = await fs.stat(filePath);
      stat = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      this.entries.delete(filePath);
      return undefined;
    }

    const cached = this.entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const value = compute(content);
    this.entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  public delete(filePath: string): void {
    this.entries.delete(filePath);
  }

  public clear(): void {
    this.entries.clear();
  }
}

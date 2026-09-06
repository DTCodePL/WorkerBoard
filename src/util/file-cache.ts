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
  // Sciezki, o ktore pytano od ostatniego pruneUnseen() - podstawa do
  // usuniecia wpisow, o ktore nikt juz nie pyta (np. sesja wypadla z okna
  // lookback), zeby mapa nie rosla bez ograniczen przy dlugo dzialajacym
  // VS Code.
  private readonly seenSincePrune = new Set<string>();

  public async getOrCompute(
    filePath: string,
    compute: (content: string) => T,
    onWarning?: (message: string) => void
  ): Promise<T | undefined> {
    this.seenSincePrune.add(filePath);

    let stat: { mtimeMs: number; size: number };
    try {
      const stats = await fs.stat(filePath);
      stat = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error: unknown) {
      this.entries.delete(filePath);
      onWarning?.(`Nie udalo sie odczytac statystyk pliku ${filePath}: ${describeError(error)}`);
      return undefined;
    }

    const cached = this.entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error: unknown) {
      // Plik mogl zniknac albo stracic uprawnienia MIEDZY stat a readFile
      // (kompakcja transkryptu, rotacja, antywirus) - traktujemy to
      // identycznie jak blad stat: usun wpis, zwroc undefined, nigdy nie
      // pozwol, zeby awaria JEDNEGO pliku uniewaznila cale Promise.all w
      // scanner.ts.
      this.entries.delete(filePath);
      onWarning?.(`Nie udalo sie odczytac pliku ${filePath}: ${describeError(error)}`);
      return undefined;
    }

    const value = compute(content);
    this.entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  // Usuwa wpisy, o ktore nikt nie pytal od ostatniego wywolania - wolane
  // raz na koniec kazdego pelnego skanu z scanner.ts.
  public pruneUnseen(): void {
    for (const key of this.entries.keys()) {
      if (!this.seenSincePrune.has(key)) {
        this.entries.delete(key);
      }
    }
    this.seenSincePrune.clear();
  }

  public get size(): number {
    return this.entries.size;
  }

  public delete(filePath: string): void {
    this.entries.delete(filePath);
  }

  public clear(): void {
    this.entries.clear();
    this.seenSincePrune.clear();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

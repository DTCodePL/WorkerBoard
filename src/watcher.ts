// Odswiezanie: fs.watch jako szybka sciezka powiadomien + polling jako
// niezawodne zabezpieczenie, wstrzymywane gdy widok nie jest widoczny.

import * as fs from 'node:fs';

const DEBOUNCE_MS = 400;

export interface WatcherLogger {
  warn(message: string): void;
}

export class BoardWatcher {
  private readonly fsWatchers: fs.FSWatcher[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollIntervalMs: number;
  private paused = false;

  public constructor(
    private readonly onScanRequested: () => void,
    private readonly logger: WatcherLogger,
    pollIntervalMs: number
  ) {
    this.pollIntervalMs = pollIntervalMs;
  }

  public start(watchedPaths: readonly string[]): void {
    this.stop();

    for (const watchedPath of watchedPaths) {
      try {
        const watcher = fs.watch(watchedPath, { recursive: true }, () => this.onFsEvent());
        watcher.on('error', (error) => this.logger.warn(`fs.watch zglosil blad dla ${watchedPath}: ${describeError(error)}`));
        this.fsWatchers.push(watcher);
      } catch (error: unknown) {
        // Na Windows fs.watch z recursive:true potrafi rzucic na glebokich
        // lub nieistniejacych jeszcze drzewach katalogow - polling ponizej
        // i tak pokryje odswiezanie, wiec to nie jest blad krytyczny.
        this.logger.warn(`Nie udalo sie uruchomic fs.watch dla ${watchedPath}: ${describeError(error)}`);
      }
    }

    this.startPolling();
  }

  public stop(): void {
    for (const watcher of this.fsWatchers.splice(0)) {
      watcher.close();
    }
    this.stopPolling();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  public setPollIntervalMs(pollIntervalMs: number): void {
    this.pollIntervalMs = pollIntervalMs;
    if (!this.paused) {
      this.startPolling();
    }
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    if (paused) {
      this.stopPolling();
    } else {
      this.startPolling();
      this.onScanRequested();
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.onScanRequested(), this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private onFsEvent(): void {
    if (this.paused) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.onScanRequested(), DEBOUNCE_MS);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Typy i enumy wspoldzielone przez skanery, watcher i widok webview.
// Jeden plik trzyma caly komplet typow - to nie jest projekt Angulara,
// wiec zasada "jedna deklaracja publiczna na plik" tu nie obowiazuje.

export enum TaskEngine {
  Claude = 'claude',
  Spark = 'spark',
  Codex = 'codex'
}

export enum TaskStatus {
  Running = 'running',
  // Wylacznie TaskKind.Session: tura zamknieta (odpowiedz asystenta juz
  // padla), zaden nowszy user, mtime wciaz w oknie waitingLookbackMinutes -
  // sesja czeka na reakcje czlowieka. Subagenci i workery nigdy go nie dostaja.
  WaitingForUser = 'waiting_for_user',
  Idle = 'idle',
  Done = 'done',
  Failed = 'failed',
  Killed = 'killed',
  Stale = 'stale'
}

export enum TaskKind {
  Session = 'session',
  Subagent = 'subagent',
  Worker = 'worker'
}

export interface WorkerTask {
  readonly id: string;
  readonly engine: TaskEngine;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly title: string;
  readonly subtitle?: string;
  readonly repo?: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly lastActivityAt?: number;
  readonly exitCode?: number;
  readonly logPath?: string;
  readonly transcriptPath?: string;
  readonly depth?: number;
  readonly parentId?: string;
  // Wylacznie TaskKind.Worker (Spark/Codex): id sesji Claude, do ktorej
  // wpisal ten worker (z env CLAUDE_CODE_SESSION_ID w worker-run.ps1). Pole
  // opcjonalne - starsze rekordy i workery odpalone poza Claude Code go nie
  // maja, trafiaja wtedy do grupy zapasowej "BEZ PRZYPISANIA".
  readonly sessionId?: string;
  // Metryki - doliczane WYLACZNIE dla zadan, ktore przeszly filtr Running
  // (patrz scanner.ts), nigdy dla calej migawki przed filtrowaniem. Kazde
  // pole zostaje undefined, gdy nie da sie go wyznaczyc - nigdy zero ani
  // wartosc zgadywana, bo "0" i "nie wiem" musza wygladac inaczej na karcie.
  readonly model?: string;
  readonly effort?: string;
  readonly branch?: string;
  readonly currentActivity?: string;
  readonly tokensUsed?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

// Kontrakt pliku heartbeatu zapisywanego przez zewnetrzny wrapper PowerShell.
// Traktowany jako dane wejsciowe z zewnatrz - wszystkie pola poza tymi
// oznaczonymi jako opcjonalne moga w praktyce byc nieobecne lub null.
export interface HeartbeatRecord {
  readonly schemaVersion: number;
  readonly id: string;
  readonly engine: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly title: string;
  readonly repo?: string | null;
  readonly briefPath?: string | null;
  // Opcjonalne - worker moze jeszcze nie miec PID-u (np. nie zdazyl
  // wystartowac). Pole NIE jest na liscie wymaganych do zbudowania zadania.
  readonly pid?: number | null;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly exitCode?: number | null;
  readonly status: string;
  readonly logPath?: string | null;
  readonly sessionId?: string | null;
}

// Migawka wyslana z rozszerzenia do webview.
export interface BoardSnapshot {
  readonly type: 'snapshot';
  readonly tasks: readonly WorkerTask[];
  readonly scannedAt: number;
}

// Wiadomosci wysylane z webview do rozszerzenia.
export enum WebviewMessageType {
  OpenLog = 'openLog',
  OpenTranscript = 'openTranscript',
  Kill = 'kill',
  Ready = 'ready'
}

export interface WebviewMessage {
  readonly type: WebviewMessageType;
  readonly id?: string;
}

// Punkt wejscia rozszerzenia: activate/deactivate, rejestracja widoku,
// komend i mechanizmu odswiezania.

import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { BoardView } from './board-view.js';
import { Scanner, ScanConfig } from './scanner.js';
import { BoardWatcher } from './watcher.js';
import { WebviewMessage, WebviewMessageType } from './model.js';
import { listFinishedHeartbeatFiles } from './sources/heartbeats.js';
import { isProcessAlive } from './util/pid.js';
import * as fs from 'node:fs/promises';

const CONFIG_SECTION = 'workerBoard';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Worker Board');
  // Jednorazowy wpis przy starcie - pozwala potwierdzic z panelu Output,
  // ktora wersja rozszerzenia faktycznie dziala (przydatne, bo VSIX nie
  // zawsze jest przeinstalowywany od razu po zbudowaniu nowej wersji).
  const version = (context.extension.packageJSON as { version?: string }).version ?? 'nieznana';
  outputChannel.appendLine(`Worker Board ${version} uruchomiony`);

  const scanner = new Scanner();

  let currentConfig = resolveConfig();

  const boardView = new BoardView(
    context.extensionUri,
    (message) => handleWebviewMessage(message, boardView, outputChannel),
    (visible) => watcher.setPaused(!visible)
  );

  const performScan = async (): Promise<void> => {
    const result = await scanner.scan(currentConfig, { warn: (message) => outputChannel.appendLine(message) });
    boardView.postSnapshot(result.tasks, result.scannedAt);
  };

  const watcher = new BoardWatcher(
    () => {
      performScan().catch((error: unknown) => outputChannel.appendLine(`Blad skanowania: ${describeError(error)}`));
    },
    { warn: (message) => outputChannel.appendLine(message) },
    currentConfig.pollIntervalMs
  );

  watcher.start([currentConfig.workerStatusPath, currentConfig.claudeProjectsPath]);
  performScan().catch((error: unknown) => outputChannel.appendLine(`Blad pierwszego skanowania: ${describeError(error)}`));

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerWebviewViewProvider(BoardView.viewId, boardView),
    vscode.commands.registerCommand('workerBoard.refresh', () => {
      performScan().catch((error: unknown) => outputChannel.appendLine(`Blad odswiezania: ${describeError(error)}`));
    }),
    vscode.commands.registerCommand('workerBoard.clearFinished', () => {
      clearFinishedHeartbeats(currentConfig.workerStatusPath, outputChannel)
        .then(() => performScan())
        .catch((error: unknown) => outputChannel.appendLine(`Blad czyszczenia zakonczonych: ${describeError(error)}`));
    }),
    vscode.commands.registerCommand('workerBoard.openStatusFolder', () => {
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(currentConfig.workerStatusPath)).then(undefined, (error: unknown) => {
        outputChannel.appendLine(`Nie udalo sie otworzyc katalogu stanu: ${describeError(error)}`);
      });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      currentConfig = resolveConfig();
      watcher.setPollIntervalMs(currentConfig.pollIntervalMs);
      watcher.start([currentConfig.workerStatusPath, currentConfig.claudeProjectsPath]);
      performScan().catch((error: unknown) => outputChannel.appendLine(`Blad skanowania po zmianie konfiguracji: ${describeError(error)}`));
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && boardView.isVisible) {
        performScan().catch((error: unknown) => outputChannel.appendLine(`Blad skanowania po powrocie fokusu: ${describeError(error)}`));
      }
    }),
    { dispose: () => watcher.stop() }
  );
}

export function deactivate(): void {
  // Sprzatanie odbywa sie przez context.subscriptions zarejestrowane w activate.
}

function resolveConfig(): ScanConfig {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const claudeProjectsPath = configuration.get<string>('claudeProjectsPath', '').trim();
  const workerStatusPath = configuration.get<string>('workerStatusPath', '').trim();
  const codexSessionsPath = configuration.get<string>('codexSessionsPath', '').trim();

  return {
    claudeProjectsPath: claudeProjectsPath || path.join(os.homedir(), '.claude', 'projects'),
    workerStatusPath: workerStatusPath || path.join(os.homedir(), '.claude', 'worker-status'),
    codexSessionsPath: codexSessionsPath || path.join(os.homedir(), '.codex', 'sessions'),
    claudeLookbackHours: configuration.get<number>('claudeLookbackHours', 24),
    pollIntervalMs: configuration.get<number>('pollIntervalMs', 5000),
    subagentStaleAfterMinutes: configuration.get<number>('subagentStaleAfterMinutes', 15),
    contextWindowTokens: configuration.get<number>('contextWindowTokens', 1000000),
    waitingLookbackMinutes: configuration.get<number>('waitingLookbackMinutes', 120)
  };
}

function handleWebviewMessage(message: WebviewMessage, boardView: BoardView, outputChannel: vscode.OutputChannel): void {
  switch (message.type) {
    case WebviewMessageType.OpenLog:
      openPath(boardView, message.id, (task) => task.logPath, outputChannel);
      return;
    case WebviewMessageType.OpenTranscript:
      openPath(boardView, message.id, (task) => task.transcriptPath, outputChannel);
      return;
    case WebviewMessageType.Kill:
      killTask(boardView, message.id, outputChannel);
      return;
    default:
      return;
  }
}

function openPath(boardView: BoardView, id: string | undefined, pick: (task: { logPath?: string; transcriptPath?: string }) => string | undefined, outputChannel: vscode.OutputChannel): void {
  if (!id) {
    return;
  }
  const task = boardView.findTask(id);
  const targetPath = task ? pick(task) : undefined;
  if (!targetPath) {
    outputChannel.appendLine(`Brak sciezki do otwarcia dla zadania ${id}`);
    return;
  }
  vscode.workspace.openTextDocument(vscode.Uri.file(targetPath)).then(
    (document) => {
      vscode.window.showTextDocument(document, { preview: true }).then(undefined, (error: unknown) => {
        outputChannel.appendLine(`Nie udalo sie pokazac dokumentu ${targetPath}: ${describeError(error)}`);
      });
    },
    (error: unknown) => {
      vscode.window.showErrorMessage(`Nie udalo sie otworzyc pliku: ${targetPath}`);
      outputChannel.appendLine(`Nie udalo sie otworzyc pliku ${targetPath}: ${describeError(error)}`);
    }
  );
}

function killTask(boardView: BoardView, id: string | undefined, outputChannel: vscode.OutputChannel): void {
  if (!id) {
    return;
  }
  const task = boardView.findTask(id);
  if (!task?.pid) {
    return;
  }

  const pid = task.pid;
  vscode.window
    .showWarningMessage(`Na pewno zabic zadanie "${task.title}" (PID ${pid})?`, { modal: true }, 'Zabij')
    .then((choice) => {
      if (choice !== 'Zabij') {
        return;
      }
      try {
        if (isProcessAlive(pid)) {
          process.kill(pid);
        }
      } catch (error: unknown) {
        vscode.window.showErrorMessage(`Nie udalo sie zabic procesu ${pid}: ${describeError(error)}`);
        outputChannel.appendLine(`Nie udalo sie zabic procesu ${pid}: ${describeError(error)}`);
      }
    });
}

async function clearFinishedHeartbeats(workerStatusPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
  const finishedFiles = await listFinishedHeartbeatFiles(workerStatusPath);
  if (finishedFiles.length === 0) {
    vscode.window.showInformationMessage('Brak zakończonych lub przerwanych workerów do wyczyszczenia.');
    return;
  }

  // Tekst mowi prawde o tym, co faktycznie zostanie usuniete -
  // listFinishedHeartbeatFiles zwraca zarowno prawdziwie zakonczone
  // (done/failed/killed), jak i osierocone (running z martwym PID, np. po
  // zabiciu sesji Claude Code razem z workerem) - nigdy statusy nieznane
  // ani running z zywym PID.
  const choice = await vscode.window.showWarningMessage(
    `Usunac ${finishedFiles.length} plikow zakonczonych lub przerwanych workerow z katalogu stanu?`,
    { modal: true },
    'Usun'
  );
  if (choice !== 'Usun') {
    return;
  }

  for (const filePath of finishedFiles) {
    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      outputChannel.appendLine(`Nie udalo sie usunac ${filePath}: ${describeError(error)}`);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

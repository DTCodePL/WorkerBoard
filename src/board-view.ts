// WebviewViewProvider dla panelu "Workery" - buduje HTML powloki webview,
// utrzymuje ostatnia migawke zadan i przekazuje wiadomosci z webview dalej.

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { WebviewMessage, WebviewMessageType, WorkerTask } from './model.js';

export class BoardView implements vscode.WebviewViewProvider {
  public static readonly viewId = 'workerBoard.cards';

  private view: vscode.WebviewView | undefined;
  private latestTasks: readonly WorkerTask[] = [];
  private latestScannedAt = 0;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: WebviewMessage) => void,
    private readonly onVisibilityChanged: (visible: boolean) => void
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type === WebviewMessageType.Ready) {
        this.postSnapshot(this.latestTasks, this.latestScannedAt);
        return;
      }
      this.onMessage(message);
    });

    webviewView.onDidChangeVisibility(() => {
      this.onVisibilityChanged(webviewView.visible);
      // Webview widoku bocznego nie jest niszczony przy ukryciu (w
      // przeciwienstwie do webview panelu w obszarze edytora), wiec jego
      // wlasny setInterval licznika tykalby dalej w tle bez tego sygnalu.
      this.postVisibility(webviewView.visible);
    });
  }

  public get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  public postSnapshot(tasks: readonly WorkerTask[], scannedAt: number): void {
    this.latestTasks = tasks;
    this.latestScannedAt = scannedAt;
    this.view?.webview.postMessage({ type: 'snapshot', tasks, scannedAt });
  }

  public postVisibility(visible: boolean): void {
    this.view?.webview.postMessage({ type: 'visibility', visible });
  }

  public findTask(id: string): WorkerTask | undefined {
    return this.latestTasks.find((task) => task.id === id);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;

    return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Workery</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

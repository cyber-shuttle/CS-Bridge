import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { WebviewMessage } from './models';

type ViewKind = 'sessions' | 'hosts' | 'stats' | 'summary';

// Base for the sidebar webview views: renders the view's bundle and routes messages to/from the webview.
// Subclasses set viewKind and override the hooks below.
export abstract class WebviewProvider implements vscode.WebviewViewProvider {
    protected abstract readonly viewKind: ViewKind;
    protected readonly logger = Logger.getInstance();
    protected view?: vscode.WebviewView;

    constructor(protected readonly extensionUri: vscode.Uri) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        const webview = webviewView.webview;
        webview.options = { enableScripts: true };
        this.view = webviewView;
        const msgSub = webview.onDidReceiveMessage(data => this.handleMessage(data));
        const visSub = webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { void this.pushState(); } });
        webviewView.onDidDispose(() => {
            // Ignore a replaced webview's late dispose so it can't clear the current view.
            if (this.view === webviewView) { this.view = undefined; }
            msgSub.dispose();
            visSub.dispose();
        });
        this.onResolved();
        webview.html = renderHtml(webview, this.extensionUri, this.viewKind);
    }

    // Override hooks (default no-op):
    protected handleMessage(_data: WebviewMessage): void { }
    protected pushState(): void | Promise<void> { }
    protected onResolved(): void { }

    protected showError(message: string, error: unknown): void {
        this.logger.error(message, error);
        vscode.window.showErrorMessage(`${message}: ${errMsg(error)}`);
    }
}

// CSP-gated HTML shell that loads the view's esbuild bundle (out/<view>.js) + codicons.
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: ViewKind): string {
    const nonce = getNonce();
    const codiconCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'codicons', 'codicon.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', `${view}.js`));

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" id="vscode-codicon-stylesheet" href="${codiconCss}" nonce="${nonce}">
        <!-- vscode-button height is locked by a shadow-DOM line-height; ::part(base) is the only way to make it fit the compact card rows. -->
        <style nonce="${nonce}">vscode-button::part(base){line-height:16px;}</style>
    </head>
    <body style="margin:0;padding:0"><div id="root"></div>
    <script nonce="${nonce}" src="${js}"></script>
    </body>
    </html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
    return text;
}

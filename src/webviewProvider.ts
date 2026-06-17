import * as vscode from 'vscode';
import { Logger } from './logger';

type ViewKind = 'sessions' | 'hosts' | 'stats';

// Shared wiring for the sidebar webview views: enables scripts, renders the view's bundle, routes incoming
// messages to handleMessage, re-pushes state on (re)visibility, and tracks/clears the resolved view (guarding
// against a late dispose of a replaced webview). Subclasses set viewKind and override the hooks they need.
export abstract class WebviewProvider implements vscode.WebviewViewProvider {
    protected abstract readonly viewKind: ViewKind;
    protected readonly _logger = Logger.getInstance();
    protected _view?: vscode.WebviewView;

    constructor(protected readonly _extensionUri: vscode.Uri) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        const webview = webviewView.webview;
        webview.options = { enableScripts: true };
        this._view = webviewView;
        const msgSub = webview.onDidReceiveMessage(data => this.handleMessage(data));
        const visSub = webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { void this.pushState(); } });
        webviewView.onDidDispose(() => {
            if (this._view === webviewView) { this._view = undefined; }
            msgSub.dispose();
            visSub.dispose();
        });
        this.onResolved();
        webview.html = renderHtml(webview, this._extensionUri, this.viewKind);
    }

    // Handle a message posted from the webview. Default: ignore.
    protected handleMessage(_data: any): void { }

    // (Re)build and post this view's state. Fired on webview 'ready' and on re-visibility. Default: nothing.
    protected pushState(): void | Promise<void> { }

    // Run once each time the view is resolved, before its HTML is set. Default: nothing.
    protected onResolved(): void { }
}

// Nonce-gated CSP shell that loads the per-view esbuild bundle (out/<view>.js) + codicons into the webview.
function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: ViewKind): string {
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

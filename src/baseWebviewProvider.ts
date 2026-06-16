import * as vscode from 'vscode';
import { Logger } from './logger';
import { getWebviewContent } from './webviewContent';

type ViewKind = 'sessions' | 'hosts' | 'stats';

// Shared wiring for the sidebar webview views: enables scripts, renders the view's bundle, routes incoming
// messages to handleMessage, re-pushes state on (re)visibility, and tracks/clears the resolved view (guarding
// against a late dispose of a replaced webview). Subclasses set viewKind and override the hooks they need.
export abstract class BaseWebviewProvider implements vscode.WebviewViewProvider {
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
        webview.html = getWebviewContent(webview, this._extensionUri, this.viewKind);
    }

    // Handle a message posted from the webview. Default: ignore.
    protected handleMessage(_data: any): void { }

    // (Re)build and post this view's state. Fired on webview 'ready' and on re-visibility. Default: nothing.
    protected pushState(): void | Promise<void> { }

    // Run once each time the view is resolved, before its HTML is set. Default: nothing.
    protected onResolved(): void { }
}

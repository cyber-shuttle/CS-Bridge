import * as vscode from 'vscode';
import { getWebviewContent } from './webviewContent';

// Webview provider for the Stats view. Skeleton for now — the view renders a "Coming Soon" placeholder;
// session-statistics logic will live here.
export class StatsProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'csbridge.statsView';

    constructor(private readonly _extensionUri: vscode.Uri) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        const webview = webviewView.webview;
        webview.options = { enableScripts: true };
        webview.html = getWebviewContent(webview, this._extensionUri, 'stats');
    }
}

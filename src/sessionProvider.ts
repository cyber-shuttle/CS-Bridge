import * as vscode from 'vscode';
import { Logger } from './logger';
import { Session } from './models';
import { getSessionWebviewContent } from './webviews/sessionWebview';

export class SessionProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cybershuttle.sessionsView';

    private readonly _logger = Logger.getInstance();

    constructor(private readonly _extensionUri: vscode.Uri) {
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken): Thenable<void> | void {

        webviewView.webview.options = {
            enableScripts: true,
        };

        const sessions: Session[] = [
            { id: 'session1', name: 'Session 1', cluster: 'Cluster A', status: 'running' },
            { id: 'session2', name: 'Session 2', cluster: 'Cluster B', status: 'pending' },
        ];

        try {
            webviewView.webview.html = getSessionWebviewContent(webviewView.webview, this._extensionUri, sessions);
        } catch (error) {
            this._logger.error('Error generating session webview content:', error);
            webviewView.webview.html = `<html><body><h2>Error loading sessions</h2><p>${error instanceof Error ? error.message : String(error)}</p></body></html>`;
        }
    }




}
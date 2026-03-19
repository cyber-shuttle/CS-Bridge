import * as vscode from 'vscode';
import { Logger } from './logger';
import { Session, SlurmSession } from './models';
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

        const sessions: SlurmSession[] = [
            {
                id: 'session1', name: 'Session 1',
                cluster: 'Cluster A', status: 'running', tunnelType: 'devtunnel',
                tunnelId: 'tunnel1', tunnelUrl: 'http://localhost:3000',
                jobId: '12345', queue: 'gpu', wallTime: '01:00:00',
                gpuCount: 2, gpuClass: 'A100', cpus: 16, memory: '64GB',
                jobDirectory: '/home/user/job1', allocation: 'allocation1'
            },
        ];

        try {
            webviewView.webview.html = getSessionWebviewContent(webviewView.webview, this._extensionUri, sessions);
        } catch (error) {
            this._logger.error('Error generating session webview content:', error);
            webviewView.webview.html = `<html><body><h2>Error loading sessions</h2><p>${error instanceof Error ? error.message : String(error)}</p></body></html>`;
        }
    }




}
import * as vscode from 'vscode';
import { Logger } from './logger';
import { SlurmSession } from './models';
import { getSessionWebviewContent } from './webviews/sessionWebview';
import { getSlurmClusterInfo } from './modules/sshSupport';

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

        webviewView.webview.onDidReceiveMessage((data) => this._onMessageFromJs(data, webviewView.webview));

        try {
            webviewView.webview.html = getSessionWebviewContent(webviewView.webview, this._extensionUri, sessions);
        } catch (error) {
            this._logger.error('Error generating session webview content:', error);
            webviewView.webview.html = `<html><body><h2>Error loading sessions</h2><p>${error instanceof Error ? error.message : String(error)}</p></body></html>`;
        }
    }

    // Handle messages from the webview here (e.g., refresh sessions, open terminal, etc.)
    private _onMessageFromJs(data: any, webView: vscode.Webview) {
        this._logger.info('Received message from webview:', data);

        const command = data.command;
        switch (command) {
            case 'fetchSlurmClusterInfo':
                // vscode.postMessage({ command: 'fetchSlurmClusterInfo', host: host });
                const host = data.host;
                this._logger.info(`Fetching slurm cluster info for host: ${host}`);
                getSlurmClusterInfo(host).then(clusterInfo => {
                    this._logger.info('Fetched slurm cluster info:', clusterInfo);
                    // Send back to sessions.js
                    webView.postMessage({ command: 'slurmClusterInfo', host, clusterInfo });
                }).catch(error => {
                    this._logger.error('Error fetching slurm cluster info:', error);
                    webView.postMessage({ command: 'slurmClusterInfoError', host, message: error instanceof Error ? error.message : String(error) });
                });
                break;
            default:
                this._logger.warn('Unknown command from webview:', command);
        }
    }
}
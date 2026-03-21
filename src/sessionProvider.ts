import * as vscode from 'vscode';
import { Logger } from './logger';
import { SlurmSession } from './models';
import { getSessionWebviewContent } from './webviews/sessionWebview';
import { getSlurmClusterInfo } from './modules/sshSupport';
import { addSession, getAllSessions } from './extensionStore';

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

        webviewView.webview.onDidReceiveMessage((data) => this._onMessageFromJs(data, webviewView.webview));

        try {
            this._refereshSessions(webviewView.webview);
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
            case 'addSession':
                // Handle adding a new session based on data from the webview
                //vscode.postMessage({ command: 'addSession', host: host, cpus: cpus, memory: memory, gpu: gpu, wallTime: wallTime, queue: queue, allocation: allocation });
                this._logger.info('Adding new session with data:', data);
                const newSession: SlurmSession = {
                    id: `session-${Date.now()}`,
                    name: `Session ${Date.now()}`,
                    cluster: data.host,
                    status: 'not_started',
                    tunnelType: 'devtunnel',
                    tunnelId: '',
                    tunnelUrl: '',
                    jobId: '',
                    queue: data.queue || '',
                    wallTime: data.wallTime || '',
                    gpuCount: data.gpu === 'None' ? 0 : 1,
                    gpuClass: data.gpu === 'None' ? '' : data.gpu, // Could be determined based on gpuCount or additional data
                    cpus: parseInt(data.cpus) || 0,
                    memory: data.memory || '',
                    jobDirectory: '',
                    allocation: data.allocation || '',
                    submittedAt: Date.now(),
                    errorMessage: ''
                };
                addSession(newSession);
                this._refereshSessions(webView);
                break;
            default:
                this._logger.warn('Unknown command from webview:', command);
        }
    }

    private _refereshSessions(webView: vscode.Webview) {
        const sessions = getAllSessions();
        webView.html = getSessionWebviewContent(webView, this._extensionUri, sessions);
        for (const session of sessions) {
            webView.postMessage({ command: 'sessionUpdate', session: session });
        }
    }

}
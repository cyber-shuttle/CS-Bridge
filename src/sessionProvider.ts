import * as vscode from 'vscode';
import { Logger } from './logger';
import { SlurmSession, TunnelCredential } from './models';
import { getSessionWebviewContent } from './webviews/sessionWebview';
import { clearSSHConfigEntry, createSSHConfigEntry, generateSlurmScript, getSlurmClusterInfo } from './modules/sshSupport';
import { addSession, deleteSession, findSession, getAllSessions, updateSession } from './extensionStore';
import { connectSessionToSSHTunnel, createSSHServerForSession, createTunnelForSSHServer, getDevTunnelCredentials, getMicrosoftAccountInfo, switchDevTunnelAccount } from './modules/tunnelSupport';
import { cancelRunningSession, JobStatusMonitor, launchSessionWithProgress } from './modules/sessionSupport';

export class SessionProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cybershuttle.sessionsView';

    private readonly _logger = Logger.getInstance();
    private readonly _clusterHomeDirs = new Map<string, string>();

    constructor(private readonly _extensionUri: vscode.Uri) {
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken): Thenable<void> | void {

        webviewView.webview.options = {
            enableScripts: true,
        };

        webviewView.webview.onDidReceiveMessage((data) => this._onMessageFromJs(data, webviewView.webview));
        const authSub = vscode.authentication.onDidChangeSessions((e) => {
            if (e.provider.id === 'microsoft') {
                this._refereshSessions(webviewView.webview);
            }
        });
        webviewView.onDidDispose(() => authSub.dispose());
        JobStatusMonitor.init(webviewView.webview);
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
                    if (clusterInfo.homeDir) { this._clusterHomeDirs.set(host, clusterInfo.homeDir); }
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
                    jobId: '',
                    queue: data.queue || '',
                    wallTime: data.wallTime || '',
                    gpuCount: data.gpu === 'None' ? 0 : 1,
                    gpuClass: data.gpu, // Could be determined based on gpuCount or additional data
                    cpus: parseInt(data.cpus) || 0,
                    memory: data.memory || '',
                    jobDirectory: '',
                    allocation: data.allocation || '',
                    submittedAt: Date.now(),
                    errorMessage: '',
                    workingDirectory: this._clusterHomeDirs.get(data.host),
                };
                addSession(newSession);
                this._refereshSessions(webView);
                break;
            case 'prepareLaunchSession':
                // vscode.postMessage({ command: 'prepareLaunchSession', sessionId: sessionId });
                const sessionId = data.sessionId;
                this._logger.info(`Preparing to launch session with ID: ${sessionId}`);
                this._prepareLaunchSession(webView, sessionId).then(() => {
                    this._logger.info(`Preparation for session launch completed for session ID: ${sessionId}`);
                }).catch((error: Error) => {
                    this._logger.error(`Error preparing session launch for session ID ${sessionId}:`, error);
                    webView.postMessage({ command: 'prepareLaunchSessionError', sessionId: sessionId, message: error instanceof Error ? error.message : String(error) });
                    this._refereshSessions(webView);
                });
                break;
            case 'launchSession':
                // vscode.postMessage({ command: 'launchSession', sessionId: sessionId });
                const launchSessionId = data.sessionId;
                this._logger.info(`Launching session with ID: ${launchSessionId}`);
                this._launchSession(webView, launchSessionId);
                break;
            case 'cancelSessionExecution':
                const cancelSessionId = data.sessionId;
                this._logger.info(`Cancelling session execution with ID: ${cancelSessionId}`);
                this._cancelSessionExecution(webView, cancelSessionId);
                break;
            case 'connectTunnel':
                const connectSessionId = data.sessionId;
                const session = findSession(connectSessionId);

                if (!session) {
                    this._logger.error(`Session with ID ${connectSessionId} not found to connect tunnel.`);
                    vscode.window.showErrorMessage('Session not found.');
                    webView.postMessage({ command: 'connectTunnelError', sessionId: connectSessionId, message: 'Session not found.' });
                    this._refereshSessions(webView);
                    return;
                }

                this._logger.info(`Connecting tunnel for session with ID: ${connectSessionId}`);

                // NOTE: Most of the magic happens in this function
                this._connectSessionToTunnel(webView, session!).then(() => {
                    this._logger.info(`Tunnel connection process completed for session ID: ${connectSessionId}`);

                }).catch((error: Error) => {

                    this._logger.error(`Error connecting tunnel for session ID ${connectSessionId}:`, error);
                    session!.status = 'connection_broken';
                    session!.errorMessage = `Failed to connect tunnel: ${error instanceof Error ? error.message : String(error)}`;
                    updateSession(session!);
                    webView.postMessage({ command: 'connectTunnelError', sessionId: session!.id, message: error instanceof Error ? error.message : String(error) });
                    this._refereshSessions(webView);
                });
                break;
            case 'switchAuth':
                this._logger.info('Switching Dev Tunnels authentication account as requested by webview');
                switchDevTunnelAccount().then(() => {
                    this._logger.info('Dev Tunnels authentication account switched successfully');
                    webView.postMessage({ command: 'switchAuthSuccess' });
                }).catch((error: Error) => {
                    this._logger.error('Error switching Dev Tunnels authentication account:', error);
                    webView.postMessage({ command: 'switchAuthError', message: error instanceof Error ? error.message : String(error) });
                });
                break;
            case 'removeSession':
                const removeSessionId = data.sessionId;
                this._removeSession(webView, removeSessionId);
                break;
            default:
                this._logger.warn('Unknown command from webview:', command);
        }
    }

    private async _removeSession(webView: vscode.Webview, sessionId: string) {
        // The webview disables this card's buttons on click, so every exit path must
        // refresh to re-enable them (or to drop the card after a successful remove).
        const session = findSession(sessionId);
        if (!session) {
            this._logger.error(`Session with ID ${sessionId} not found to remove.`);
            vscode.window.showErrorMessage('Session not found.');
            this._refereshSessions(webView);
            return;
        }

        const removableStatuses = ['failed', 'completed', 'cancelled', 'not_started', 'expired'];
        if (!removableStatuses.includes(session.status)) {
            this._logger.warn(`Session ${sessionId} is in status ${session.status} and cannot be removed.`);
            vscode.window.showWarningMessage(`Session cannot be removed from status: ${session.status}`);
            this._refereshSessions(webView);
            return;
        }

        const choice = await vscode.window.showWarningMessage(
            'Remove session?',
            {
                modal: true,
                detail: 'This removes the session record and cleans up its SSH config entry and key file.'
            },
            'Remove'
        );
        if (choice !== 'Remove') {
            this._refereshSessions(webView);
            return;
        }

        try {
            clearSSHConfigEntry(sessionId, `cshost-${sessionId}`);
        } catch (err) {
            this._logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
        }
        deleteSession(sessionId);
        this._refereshSessions(webView);
    }

    private async _refereshSessions(webView: vscode.Webview) {
        const sessions = getAllSessions();
        const account = await getMicrosoftAccountInfo();
        webView.html = getSessionWebviewContent(webView, this._extensionUri, sessions, account);
        for (const session of sessions) {
            webView.postMessage({ command: 'sessionUpdate', session: session });
        }
    }

    // THIS FUNCTION CONTAINS THE CORE LOGIC FOR CONNECTING A SESSION TO AN SSH TUNNEL:
    // This creates the SSH server on Linkspan, sets up the tunnel, and opens a new VS Code window connected to the tunnel.
    // It also updates the session status and handles errors at each step.
    private async _connectSessionToTunnel(webView: vscode.Webview, session: SlurmSession) {

        try {
            await createSSHServerForSession(session);
        } catch (error) {
            this._logger.error(`Error creating SSH server for session ID ${session.id}:`, error);
            throw new Error(`Failed to create SSH server for session: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            await createTunnelForSSHServer(session);
        } catch (error) {
            this._logger.error(`Error creating tunnel for SSH server for session ID ${session.id}:`, error);
            throw new Error(`Failed to create tunnel for SSH server: ${error instanceof Error ? error.message : String(error)}`);
        }

        let localPort: number;
        try {
            localPort = await connectSessionToSSHTunnel(session);

        } catch (error) {
            this._logger.error(`Error connecting session ID ${session.id} to SSH tunnel:`, error);
            throw new Error(`Failed to connect session to SSH tunnel: ${error instanceof Error ? error.message : String(error)}`);
        }

        const hostAlias = createSSHConfigEntry(session.id, localPort, session.connectionInfo!.sshPrivateKey!);
        this._logger.info(`SSH config entry created for session ${session.id} with host alias ${hostAlias}. You can connect using 'ssh ${hostAlias}'`);

        vscode.commands.executeCommand(
            'vscode.newWindow',
            { remoteAuthority: `ssh-remote+${hostAlias}` }
        );

        session.status = 'connected';
        updateSession(session);
        this._refereshSessions(webView);
    }

    private _cancelSessionExecution(webView: vscode.Webview, sessionId: string) {
        const session = findSession(sessionId);
        if (!session) {
            this._logger.error(`Session with ID ${sessionId} not found to cancel.`);
            vscode.window.showErrorMessage('Session not found.');
            webView.postMessage({ command: 'cancelSessionError', sessionId: sessionId, message: 'Session not found.' });
            return;
        }

        // For simplicity, we just update the status here. In a real implementation, you'd also want to cancel the job on the cluster and clean up any resources.
        // TODO: Implement actual job cancellation logic (e.g., scancel for Slurm, API call for cloud provider, etc.)
        if (session.status === 'running' || session.status === 'pending' || session.status === 'submitting' || session.status === 'deploying_agent' || session.status === 'connected' || session.status === 'connection_broken') {
            session.status = 'cancelling';
            session.errorMessage = '';
            cancelRunningSession(session, webView).then(() => {
                this._refereshSessions(webView);
                vscode.window.showInformationMessage('Session cancellation completed. Please check the cluster to ensure the job has been cancelled and clean up any resources if necessary.');
            }).catch(error => {
                this._logger.error(`Error cancelling session with ID ${sessionId}:`, error);
                vscode.window.showErrorMessage(`Failed to cancel session: ${error instanceof Error ? error.message : String(error)}. Please check the cluster to ensure the job has been cancelled and clean up any resources if necessary.`);
                session.status = 'failed';
                session.errorMessage = `Failed to cancel session: ${error instanceof Error ? error.message : String(error)}`;
                updateSession(session);
                this._refereshSessions(webView);
            });
        } else if (session.status === 'configuring') {
            session.status = 'cancelled';
            vscode.window.showWarningMessage(`Session cancelled while configuring. If the session was already submitted to the cluster, please check the cluster for any running jobs and cancel them manually if needed.`);
            session.errorMessage = '';
        } else {
            this._logger.warn(`Session with ID ${sessionId} is in status ${session.status} and cannot be cancelled.`);
            vscode.window.showWarningMessage(`Session cannot be cancelled from status: ${session.status}`);
            webView.postMessage({ command: 'cancelSessionError', sessionId: sessionId, message: `Session cannot be cancelled from status: ${session.status}` });
            return;
        }
        updateSession(session);
        this._refereshSessions(webView);
    }

    private _launchSession(webView: vscode.Webview, sessionId: string) {
        const session = findSession(sessionId);
        if (!session) {
            this._logger.error(`Session with ID ${sessionId} not found to launch.`);
            vscode.window.showErrorMessage('Session not found.');
            webView.postMessage({ command: 'launchSessionError', sessionId: sessionId, message: 'Session not found.' });
            return;
        }
        this._logger.info(`Launching session with IDs: ${sessionId}`);
        session.status = 'submitting';
        updateSession(session);
        this._refereshSessions(webView);
        launchSessionWithProgress(session, webView).then(() => {
            this._logger.info(`Session launch completed for session ID: ${sessionId}`);
            this._refereshSessions(webView);
        }).catch(error => {
            this._logger.error(`Error launching session with ID ${sessionId}:`, error);
            vscode.window.showErrorMessage(`Failed to launch session: ${error instanceof Error ? error.message : String(error)}. Please clean up any resources on the cluster if necessary.`);
            session.status = 'failed';
            session.errorMessage = `Failed to launch session: ${error instanceof Error ? error.message : String(error)}`;
            updateSession(session);
            this._refereshSessions(webView);
        });
    }

    private async _prepareLaunchSession(webView: vscode.Webview, sessionId: string) {
        const session = findSession(sessionId);
        if (!session) {
            this._logger.error(`Session with ID ${sessionId} not found to prepare launch.`);
            vscode.window.showErrorMessage('Session not found.');
            webView.postMessage({ command: 'prepareLaunchSessionError', sessionId: sessionId, message: 'Session not found.' });
            return;
        }

        // Generate script on demand if missing
        //if (!session.batchScript) {
        let creds: TunnelCredential;
        try {
            creds = await getDevTunnelCredentials(true);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
            session.errorMessage = `Failed to get tunnel credentials: ${err.message}`;
            updateSession(session);
            this._logger.error('Failed to get tunnel credentials:', err);
            throw err;
        }
        this._logger.info('Generating Slurm script for session:', session);
        try {
            session.batchScript = generateSlurmScript(session, creds);
            this._logger.info('Generated Slurm script:', session.batchScript);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to generate Slurm script: ${err.message}`);
            session.errorMessage = `Failed to generate Slurm script: ${err.message}`;
            updateSession(session);
            this._logger.error('Failed to generate Slurm script:', err);
            throw err;
        }
        this._logger.info('Generated Slurm script:', session.batchScript);
        //}

        session.errorMessage = '';
        session.connectionInfo = undefined;
        session.status = 'configuring';
        updateSession(session);
        this._refereshSessions(webView);

        // Show preview and let user confirm
        webView.postMessage({ command: 'scriptPreview', session: session });
    }

}
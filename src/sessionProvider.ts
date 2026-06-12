import * as vscode from 'vscode';
import { Logger } from './logger';
import { SlurmClusterInfo, SlurmSession, TunnelCredential, SessionsState, HostsState } from './models';
import { getWebviewContent } from './webviewContent';
import { clearSSHConfigEntry, createSSHConfigEntry, generateSlurmScript, getSlurmClusterInfo, SshManager } from './modules/sshSupport';
import { addSession, deleteSession, findSession, getAllSessions, mutateWindowPids, updateSession, watchSessions } from './extensionStore';
import { connectSessionToSSHTunnel, createSSHServerForSession, createTunnelForSSHServer, getDevTunnelCredentials, getMicrosoftAccountInfo, switchDevTunnelAccount } from './modules/tunnelSupport';
import { cancelRunningSession, JobStatusMonitor, launchSessionWithProgress } from './modules/sessionSupport';
import { isPidAlive } from './modules/fsSupport';
import { sshCommandToConfig, assertValidHost, SshConfigEntry } from './modules/sshCommandParser';
import { MANAGED_HOSTS_PATH, USER_SSH_CONFIG_PATH, addHostToConfigFile, removeHostFromConfigFile } from './modules/sshHostsStore';

const TERMINAL_STATUSES = new Set(['cancelled', 'failed', 'completed', 'expired']);

const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

// Writable host-config files, highest priority first; system config is read-only and excluded.
const HOST_CONFIGS = {
    managed: { path: MANAGED_HOSTS_PATH, label: 'CS Bridge (managed)', display: '~/.cybershuttle/ssh_hosts' },
    user: { path: USER_SSH_CONFIG_PATH, label: 'User SSH config', display: '~/.ssh/config' },
} as const;

function openSessionWindow(sessionId: string): void {
    const path = findSession(sessionId)?.workingDirectory ?? '';
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+cshost-${sessionId}${path}/`);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

// Probe all windowPids; lazily evict dead ones. Drives the Current/Switch/Connect button.
function liveAndCleanup(s: SlurmSession): { isCurrent: boolean, windowAlive: boolean } {
    const pids = s.windowPids ?? [];
    const live = pids.filter(isPidAlive);
    if (live.length !== pids.length) { mutateWindowPids(s.id, () => live); }
    return { isCurrent: live.includes(process.pid), windowAlive: live.length > 0 };
}

export class SessionProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly sessionsViewType = 'csbridge.sessionsView';
    public static readonly hostsViewType = 'csbridge.hostsView';
    public static readonly statsViewType = 'csbridge.statsView';

    private readonly _logger = Logger.getInstance();
    private readonly _clusterInfo = new Map<string, SlurmClusterInfo>();
    private readonly _clusterErrors: Record<string, string> = {};
    private _draftHost: string | null = null;
    private _previewSession: SlurmSession | null = null;
    // One provider instance feeds both views; each resolved webview is keyed by its viewType.
    private readonly _webviews = new Map<string, vscode.Webview>();
    private readonly _shared: vscode.Disposable[] = [];
    private _sharedReady = false;

    // _myId: undefined in sidebar/non-remote windows (sees all sessions, drives monitoring); set to sessionId in cshost remote windows (scoped to that session, observes only).
    constructor(private readonly _extensionUri: vscode.Uri, private readonly _myId?: string) {
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken): Thenable<void> | void {

        const webview = webviewView.webview;
        const viewType = webviewView.viewType;
        const kind = viewType === SessionProvider.hostsViewType ? 'hosts'
            : viewType === SessionProvider.statsViewType ? 'stats'
                : 'sessions';
        webview.options = { enableScripts: true };
        this._webviews.set(viewType, webview);

        const msgSub = webview.onDidReceiveMessage((data) => this._onMessageFromJs(data));
        const visSub = webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { void this._pushState(); } });
        webviewView.onDidDispose(() => {
            // Only evict if still ours — a late dispose of an old webview must not remove a freshly re-resolved one.
            if (this._webviews.get(viewType) === webview) { this._webviews.delete(viewType); }
            msgSub.dispose();
            visSub.dispose();
        });

        this._ensureShared();
        webview.html = getWebviewContent(webview, this._extensionUri, kind);
    }

    // Window-scoped subscriptions shared by both views; set up once, disposed with the provider.
    private _ensureShared(): void {
        if (this._sharedReady) { return; }
        this._sharedReady = true;
        this._shared.push(vscode.authentication.onDidChangeSessions((e) => {
            if (e.provider.id === 'microsoft') { void this._pushState(); }
        }));
        // cshost windows only react to changes in their own session.
        let lastMine: string | undefined;
        const sessionsWatcher = watchSessions(() => {
            const mine = this._myId ? JSON.stringify(findSession(this._myId)) : undefined;
            if (mine !== undefined && mine === lastMine) { return; }
            lastMine = mine;
            void this._pushState();
        });
        this._shared.push({ dispose: () => sessionsWatcher.close() });
        JobStatusMonitor.init();
        // Sidebar only - cshost windows observe one session and don't drive monitoring.
        if (!this._myId) {
            for (const s of getAllSessions()) {
                if (s.jobId && !TERMINAL_STATUSES.has(s.status)) { JobStatusMonitor.getInstance().startMonitoring(s); }
            }
        }
    }

    dispose(): void {
        this._shared.forEach(d => d.dispose());
    }

    // Handle messages from the webview here (e.g., refresh sessions, open terminal, etc.)
    private _onMessageFromJs(data: any) {
        this._logger.info('Received message from webview:', data);

        const command = data.command;
        const id = data.sessionId;
        switch (command) {
            case 'ready':
                void this._pushState();
                break;
            case 'cancelDraftSession':
                this._draftHost = null;
                void this._pushState();
                break;
            case 'dismissPreview':
                this._previewSession = null;
                void this._pushState();
                break;
            case 'addSession':
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
                    workingDirectory: this._clusterInfo.get(data.host)?.homeDir,
                };
                addSession(newSession);
                this._draftHost = null;
                void this._pushState();
                break;
            case 'prepareLaunchSession':
                this._logger.info(`Preparing to launch session with ID: ${id}`);
                this._prepareLaunchSession(id).then(() => {
                    this._logger.info(`Preparation for session launch completed for session ID: ${id}`);
                }).catch((error: Error) => {
                    this._logger.error(`Error preparing session launch for session ID ${id}:`, error);
                    void this._pushState();
                });
                break;
            case 'launchSession':
                this._logger.info(`Launching session with ID: ${id}`);
                this._launchSession(id);
                break;
            case 'cancelSessionExecution':
                this._logger.info(`Cancelling session execution with ID: ${id}`);
                this._cancelSessionExecution(id);
                break;
            case 'connectTunnel':
                void this._connectSessionToTunnel(id);
                break;
            case 'switchAuth':
                this._logger.info('Switching Dev Tunnels authentication account as requested by webview');
                switchDevTunnelAccount().then(() => {
                    this._logger.info('Dev Tunnels authentication account switched successfully');
                    void this._pushState();
                }).catch((error: Error) => {
                    this._logger.error('Error switching Dev Tunnels authentication account:', error);
                    void this._pushState();
                });
                break;
            case 'removeSession':
                this._removeSession(id);
                break;
            case 'removeSshHost':
                this._removeSshHost(data.name, data.source);
                break;
            default:
                this._logger.warn('Unknown command from webview:', command);
        }
    }

    private _requireSession(id: string, action: string, push: boolean): SlurmSession | undefined {
        const s = findSession(id);
        if (!s) {
            this._logger.error(`Session with ID ${id} not found to ${action}.`);
            vscode.window.showErrorMessage('Session not found.');
            if (push) { void this._pushState(); }
        }
        return s;
    }

    private async _removeSession(sessionId: string) {
        // The webview disables this card's buttons on click, so every exit path must
        // refresh to re-enable them (or to drop the card after a successful remove).
        const session = this._requireSession(sessionId, 'remove', true);
        if (!session) { return; }

        const removableStatuses = ['failed', 'completed', 'cancelled', 'not_started', 'expired'];
        if (!removableStatuses.includes(session.status)) {
            this._logger.warn(`Session ${sessionId} is in status ${session.status} and cannot be removed.`);
            vscode.window.showWarningMessage(`Session cannot be removed from status: ${session.status}`);
            void this._pushState();
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
            void this._pushState();
            return;
        }

        try {
            clearSSHConfigEntry(sessionId, `cshost-${sessionId}`);
        } catch (err) {
            this._logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
        }
        deleteSession(sessionId);
        void this._pushState();
    }

    // Native "New Session" title action: pick a host, then show its config card as a draft in the Sessions view.
    public async startNewSession(): Promise<void> {
        const hosts = SshManager.getInstance().getMergedHosts();
        if (hosts.length === 0) {
            vscode.window.showInformationMessage('No SSH hosts configured yet — add one from the SSH Hosts view first.');
            return;
        }
        const pick = await vscode.window.showQuickPick(
            hosts.map(h => ({ label: h.name, description: h.hostname ? `${h.user ? h.user + '@' : ''}${h.hostname}` : undefined })),
            { title: 'New session', placeHolder: 'Select an SSH host to configure a session on' },
        );
        if (!pick) { return; }
        this._draftHost = pick.label;
        void this._pushState();
        this._fetchClusterInfo(pick.label);
    }

    // Shared by the host picker and the post-add "Connect" action.
    private _fetchClusterInfo(host: string): void {
        const cached = this._clusterInfo.get(host);
        if (cached) { void this._pushState(); return; }
        this._logger.info(`Fetching slurm cluster info for host: ${host}`);
        getSlurmClusterInfo(host).then(clusterInfo => {
            this._clusterInfo.set(host, clusterInfo);
            delete this._clusterErrors[host];
            void this._pushState();
        }).catch(error => {
            this._logger.error('Error fetching slurm cluster info:', error);
            this._clusterErrors[host] = errMsg(error);
            void this._pushState();
        });
    }

    // Native "Add SSH Host" title action — Remote-SSH-parity flow: prompt -> parse/validate -> pick file -> write -> notify.
    public async addSshHost(): Promise<void> {
        const command = (await vscode.window.showInputBox({
            title: 'Enter SSH Connection Command',
            placeHolder: 'E.g. ssh hello@microsoft.com -A',
            ignoreFocusOut: true,
        }))?.trim();
        if (!command) { return; }

        let entry: SshConfigEntry;
        try {
            entry = sshCommandToConfig(command);
            assertValidHost(entry);
        } catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            return;
        }

        const pick = await vscode.window.showQuickPick(
            Object.values(HOST_CONFIGS).map(c => ({ label: c.label, description: c.display, path: c.path })),
            { title: 'Select SSH configuration file to update', placeHolder: 'Where should this host be saved?' },
        );
        if (!pick) { return; }

        try {
            addHostToConfigFile(pick.path, entry);
        } catch (err) {
            this._logger.error(`Failed to write SSH host to ${pick.path}:`, err);
            vscode.window.showErrorMessage(`Failed to save SSH host: ${errMsg(err)}`);
            return;
        }
        void this._pushState();

        const choice = await vscode.window.showInformationMessage('Host added!', 'Open Config', 'Connect');
        if (choice === 'Open Config') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pick.path));
        } else if (choice === 'Connect') {
            // Start a new-session draft on the freshly added host — reveal the Sessions pane so its config card is seen.
            this._draftHost = entry.Host;
            void vscode.commands.executeCommand('csbridge.sessionsView.focus');
            void this._pushState();
            this._fetchClusterInfo(entry.Host);
        }
    }

    private async _removeSshHost(name: string, source: string): Promise<void> {
        // Delete controls render only on managed/user rows, so source is always one of these.
        const cfg = HOST_CONFIGS[source as keyof typeof HOST_CONFIGS] ?? HOST_CONFIGS.user;
        const choice = await vscode.window.showWarningMessage(
            `Remove SSH host '${name}'?`,
            { modal: true, detail: `This removes the Host entry from ${cfg.display}.` },
            'Remove'
        );
        if (choice !== 'Remove') { return; }
        try {
            removeHostFromConfigFile(cfg.path, name);
        } catch (err) {
            this._logger.error(`Failed to remove SSH host ${name} from ${cfg.path}:`, err);
            vscode.window.showErrorMessage(`Failed to remove SSH host: ${errMsg(err)}`);
        }
        void this._pushState();
    }

    // Cshost windows see only their own session; sidebar windows see all.
    private _scopedSessions(): SlurmSession[] {
        return this._myId ? getAllSessions().filter(s => s.id === this._myId) : getAllSessions();
    }

    // closeWindow (not process.kill) so we don't tear down the SSH extension host mid-cancel.
    private _autoCloseIfTerminal(): void {
        if (!this._myId) { return; }
        const s = findSession(this._myId);
        if (s && TERMINAL_STATUSES.has(s.status)) {
            vscode.commands.executeCommand('workbench.action.closeWindow');
        }
    }

    // Build each resolved view's own state slice and send it; the Sessions account fetch is skipped unless that view is open.
    private async _pushState(): Promise<void> {
        if (this._webviews.size === 0) { return; }
        try {
            const sessionsView = this._webviews.get(SessionProvider.sessionsViewType);
            const hostsView = this._webviews.get(SessionProvider.hostsViewType);
            if (sessionsView) {
                const state: SessionsState = {
                    isRemote: this._myId !== undefined,
                    account: await getMicrosoftAccountInfo(),
                    sessions: this._scopedSessions()
                        .map(s => ({ ...s, ...liveAndCleanup(s) }))
                        .sort((a, b) => b.submittedAt - a.submittedAt), // most recently added first
                    draftHost: this._draftHost,
                    clusterInfo: Object.fromEntries(this._clusterInfo),
                    clusterErrors: this._clusterErrors,
                    previewSession: this._previewSession,
                };
                sessionsView.postMessage({ command: 'state', state });
            }
            if (hostsView) {
                const state: HostsState = { sshHosts: SshManager.getInstance().getMergedHosts() };
                hostsView.postMessage({ command: 'state', state });
            }
            this._autoCloseIfTerminal();
        } catch (error) {
            this._logger.error('Failed to push webview state:', error);
        }
    }

    // THIS FUNCTION CONTAINS THE CORE LOGIC FOR CONNECTING A SESSION TO AN SSH TUNNEL:
    // This creates the SSH server on Linkspan, sets up the tunnel, and opens a new VS Code window connected to the tunnel.
    // It also updates the session status and handles errors at each step.
    private async _connectSessionToTunnel(sessionId: string) {
        const session = this._requireSession(sessionId, 'connect tunnel', true);
        if (!session) { return; }
        this._logger.info(`Connecting tunnel for session with ID: ${sessionId}`);
        try {
            // Tunnel already up - just open another window against the existing SSH config entry.
            if (session.status === 'connected' && session.connectionInfo?.sshTunnelForwardPort) {
                this._logger.info(`Reusing existing tunnel for session ${session.id}; opening new window`);
                openSessionWindow(session.id);
                // windowAlive turns true once the new window registers its pid (fs.watch -> _pushState).
                void this._pushState();
                this._logger.info(`Tunnel connection process completed for session ID: ${sessionId}`);
                return;
            }

            session.status = 'connecting';
            updateSession(session);

            try {
                await createSSHServerForSession(session);
            } catch (error) {
                this._logger.error(`Error creating SSH server for session ID ${session.id}:`, error);
                throw new Error(`Failed to create SSH server for session: ${errMsg(error)}`);
            }

            try {
                await createTunnelForSSHServer(session);
            } catch (error) {
                this._logger.error(`Error creating tunnel for SSH server for session ID ${session.id}:`, error);
                throw new Error(`Failed to create tunnel for SSH server: ${errMsg(error)}`);
            }

            let localPort: number;
            try {
                localPort = await connectSessionToSSHTunnel(session);
            } catch (error) {
                this._logger.error(`Error connecting session ID ${session.id} to SSH tunnel:`, error);
                throw new Error(`Failed to connect session to SSH tunnel: ${errMsg(error)}`);
            }

            const hostAlias = createSSHConfigEntry(session.id, localPort, session.connectionInfo!.sshPrivateKey!);
            this._logger.info(`SSH config entry created for session ${session.id} with host alias ${hostAlias}. You can connect using 'ssh ${hostAlias}'`);

            openSessionWindow(session.id);

            session.status = 'connected';
            updateSession(session);
            // windowAlive turns true once the new window registers its pid (fs.watch -> _pushState).
            void this._pushState();
            this._logger.info(`Tunnel connection process completed for session ID: ${sessionId}`);
        } catch (error) {
            this._logger.error(`Error connecting tunnel for session ID ${sessionId}:`, error);
            session.status = 'connection_broken';
            session.errorMessage = `Failed to connect tunnel: ${errMsg(error)}`;
            updateSession(session);
            void this._pushState();
        }
    }

    private async _cancelSessionExecution(sessionId: string) {
        const session = this._requireSession(sessionId, 'cancel', false);
        if (!session) { return; }

        if (session.status === 'running' || session.status === 'pending' || session.status === 'submitting' || session.status === 'deploying_agent' || session.status === 'connected' || session.status === 'connection_broken' || session.status === 'ready_to_connect' || session.status === 'connecting') {
            const choice = await vscode.window.showWarningMessage(
                'Stop session?',
                { modal: true, detail: 'This cancels the running job.' },
                'Stop'
            );
            if (choice !== 'Stop') { void this._pushState(); return; }
            session.status = 'cancelling';
            session.errorMessage = '';
            cancelRunningSession(session).then(() => {
                void this._pushState();
                vscode.window.showInformationMessage('Session cancellation completed. Please check the cluster to ensure the job has been cancelled and clean up any resources if necessary.');
            }).catch(error => {
                this._logger.error(`Error cancelling session with ID ${sessionId}:`, error);
                vscode.window.showErrorMessage(`Failed to cancel session: ${errMsg(error)}. Please check the cluster to ensure the job has been cancelled and clean up any resources if necessary.`);
                session.status = 'failed';
                session.errorMessage = `Failed to cancel session: ${errMsg(error)}`;
                updateSession(session);
                void this._pushState();
            });
        } else {
            this._logger.warn(`Session with ID ${sessionId} is in status ${session.status} and cannot be cancelled.`);
            vscode.window.showWarningMessage(`Session cannot be cancelled from status: ${session.status}`);
            void this._pushState();
            return;
        }
        updateSession(session);
        void this._pushState();
    }

    private _launchSession(sessionId: string) {
        const session = this._requireSession(sessionId, 'launch', false);
        if (!session) { return; }
        this._logger.info(`Launching session with IDs: ${sessionId}`);
        this._previewSession = null;
        session.connectionInfo = undefined;
        session.startedAt = undefined; // fresh launch: re-anchor the wall-time countdown when the new job starts running
        session.errorMessage = '';
        session.status = 'submitting';
        updateSession(session);
        void this._pushState();
        launchSessionWithProgress(session).then(() => {
            this._logger.info(`Session launch completed for session ID: ${sessionId}`);
            void this._pushState();
        }).catch(error => {
            this._logger.error(`Error launching session with ID ${sessionId}:`, error);
            vscode.window.showErrorMessage(`Failed to launch session: ${errMsg(error)}. Please clean up any resources on the cluster if necessary.`);
            session.status = 'failed';
            session.errorMessage = `Failed to launch session: ${errMsg(error)}`;
            updateSession(session);
            void this._pushState();
        });
    }

    private async _prepareLaunchSession(sessionId: string) {
        const session = this._requireSession(sessionId, 'prepare launch', false);
        if (!session) { return; }

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

        session.errorMessage = '';
        updateSession(session);
        this._previewSession = session;
        void this._pushState();
    }

}
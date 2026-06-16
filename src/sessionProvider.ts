import * as vscode from 'vscode';
import { errMsg } from './logger';
import { SlurmClusterInfo, SlurmSession, TunnelCredential, SessionsState } from './models';
import { BaseWebviewProvider } from './baseWebviewProvider';
import { clearSSHConfigEntry, createSSHConfigEntry, generateSlurmScript, getSessionPrivateKey, getSlurmClusterInfo, SshManager } from './modules/sshSupport';
import { addSession, deleteSession, findSession, getAllSessions, mutateWindowPids, updateSession, watchSessions } from './extensionStore';
import { connectSessionToSSHTunnel, deleteSessionDevTunnel, disposeAllTunnelClients, disposeSessionTunnelClient, ensureDevTunnel, ensureRemoteSession, getDevTunnelCredentials, getMicrosoftAccountInfo, switchDevTunnelAccount } from './modules/tunnelSupport';
import { cancelRunningSession, JobStatusMonitor, launchSessionWithProgress } from './modules/sessionSupport';
import { isPidAlive } from './modules/fsSupport';

const TERMINAL_STATUSES = new Set(['cancelled', 'failed', 'completed']);

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

export class SessionProvider extends BaseWebviewProvider implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly _clusterInfo = new Map<string, SlurmClusterInfo>();
    private readonly _clusterErrors: Record<string, string> = {};
    private _draftHost: string | null = null;
    private _editingId: string | null = null;
    private _previewSession: SlurmSession | null = null;
    private readonly _shared: vscode.Disposable[] = [];
    private readonly _connecting = new Set<string>(); // session ids with an in-flight connect, to drop re-entrant requests
    private _sharedReady = false;

    // _myId: undefined in sidebar/non-remote windows (sees all sessions, drives monitoring); set to sessionId in cshost remote windows (scoped to that session, observes only).
    constructor(extensionUri: vscode.Uri, private readonly _myId?: string) {
        super(extensionUri);
    }

    // Wire the window-scoped session subscriptions the first time the Sessions view resolves.
    protected onResolved(): void {
        this._ensureShared();
    }

    // Window-scoped subscriptions; set up once, disposed with the provider.
    private _ensureShared(): void {
        if (this._sharedReady) { return; }
        this._sharedReady = true;
        this._shared.push(vscode.authentication.onDidChangeSessions((e) => {
            if (e.provider.id === 'microsoft') { void this.pushState(); }
        }));
        // cshost windows only react to changes in their own session.
        let lastMine: string | undefined;
        const sessionsWatcher = watchSessions(() => {
            const mine = this._myId ? JSON.stringify(findSession(this._myId)) : undefined;
            if (mine !== undefined && mine === lastMine) { return; }
            lastMine = mine;
            void this.pushState();
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
        void disposeAllTunnelClients(); // window close: free local ports (remote stays, reaped by linkspan)
    }

    // Handle messages from the webview here (e.g., refresh sessions, open terminal, etc.)
    protected handleMessage(data: any) {
        this._logger.info('Received message from webview:', data);

        const command = data.command;
        const id = data.sessionId;
        switch (command) {
            case 'ready':
                void this.pushState();
                break;
            case 'cancelDraftSession':
                this._draftHost = null;
                void this.pushState();
                break;
            case 'dismissPreview':
                this._previewSession = null;
                void this.pushState();
                break;
            case 'addSession': {
                const newSession: SlurmSession = {
                    id: `session-${Date.now()}`,
                    name: `Session ${Date.now()}`,
                    cluster: data.host,
                    status: 'not_started',
                    tunnelType: 'devtunnel',
                    jobId: '',
                    jobDirectory: '',
                    submittedAt: Date.now(),
                    errorMessage: '',
                    workingDirectory: this._clusterInfo.get(data.host)?.homeDir,
                    ...this._paramsFromData(data),
                };
                addSession(newSession);
                this._draftHost = null;
                void this.pushState();
                break;
            }
            case 'editSession': {
                const s = this._requireSession(id, 'edit', true);
                if (!s) { break; }
                this._editingId = id;
                void this.pushState();
                this._fetchClusterInfo(s.cluster);
                break;
            }
            case 'cancelEditSession':
                this._editingId = null;
                void this.pushState();
                break;
            case 'saveSession': {
                const s = this._requireSession(id, 'save', true);
                if (!s) { break; }
                Object.assign(s, this._paramsFromData(data));
                s.batchScript = undefined; // params changed; the script is regenerated at launch
                updateSession(s);
                this._editingId = null;
                void this.pushState();
                break;
            }
            case 'prepareLaunchSession':
                this._logger.info(`Preparing to launch session with ID: ${id}`);
                this._prepareLaunchSession(id).then(() => {
                    this._logger.info(`Preparation for session launch completed for session ID: ${id}`);
                }).catch((error: Error) => {
                    this._logger.error(`Error preparing session launch for session ID ${id}:`, error);
                    void this.pushState();
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
            case 'removeSession':
                this._removeSession(id);
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
            if (push) { void this.pushState(); }
        }
        return s;
    }

    private async _removeSession(sessionId: string) {
        // The webview disables this card's buttons on click, so every exit path must
        // refresh to re-enable them (or to drop the card after a successful remove).
        const session = this._requireSession(sessionId, 'remove', true);
        if (!session) { return; }

        const removableStatuses = ['failed', 'completed', 'cancelled', 'not_started'];
        if (!removableStatuses.includes(session.status)) {
            this._logger.warn(`Session ${sessionId} is in status ${session.status} and cannot be removed.`);
            vscode.window.showWarningMessage(`Session cannot be removed from status: ${session.status}`);
            void this.pushState();
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
            void this.pushState();
            return;
        }

        await disposeSessionTunnelClient(sessionId);
        await deleteSessionDevTunnel(session);
        try {
            clearSSHConfigEntry(sessionId, `cshost-${sessionId}`);
        } catch (err) {
            this._logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
        }
        deleteSession(sessionId);
        void this.pushState();
    }

    // Native account title action: open the Microsoft account switcher (sign in if needed), then refresh.
    public async switchAccount(): Promise<void> {
        try {
            await switchDevTunnelAccount();
        } catch (error) {
            this._logger.error('Error switching Dev Tunnels authentication account:', error);
            vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${errMsg(error)}`);
        }
        void this.pushState();
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
        this.startSessionDraft(pick.label);
    }

    // Reveal a new-session draft card for an already-chosen host. Also the handoff target for the SSH
    // Hosts view's post-add "Connect" action (csbridge.newSessionOnHost).
    public startSessionDraft(host: string): void {
        this._draftHost = host;
        void vscode.commands.executeCommand('csbridge.sessionsView.focus');
        void this.pushState();
        this._fetchClusterInfo(host);
    }

    // Map the config-form message onto a session's resource params (shared by add + save).
    private _paramsFromData(data: any): Pick<SlurmSession, 'queue' | 'wallTime' | 'gpuCount' | 'gpuClass' | 'cpus' | 'memory' | 'allocation'> {
        return {
            queue: data.queue || '',
            wallTime: data.wallTime || '',
            gpuCount: data.gpu === 'None' ? 0 : 1,
            gpuClass: data.gpu,
            cpus: parseInt(data.cpus) || 0,
            memory: data.memory || '',
            allocation: data.allocation || '',
        };
    }

    // Shared by the host picker and the post-add "Connect" action.
    private _fetchClusterInfo(host: string): void {
        const cached = this._clusterInfo.get(host);
        if (cached) { void this.pushState(); return; }
        this._logger.info(`Fetching slurm cluster info for host: ${host}`);
        getSlurmClusterInfo(host).then(clusterInfo => {
            this._clusterInfo.set(host, clusterInfo);
            delete this._clusterErrors[host];
            void this.pushState();
        }).catch(error => {
            this._logger.error('Error fetching slurm cluster info:', error);
            this._clusterErrors[host] = errMsg(error);
            void this.pushState();
        });
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

    // Build the Sessions view state slice and send it; no-op until the view is resolved.
    protected async pushState(): Promise<void> {
        const view = this._view;
        if (!view) { return; }
        try {
            const account = await getMicrosoftAccountInfo();
            view.description = account.label ?? 'Not Signed In';
            const state: SessionsState = {
                isRemote: this._myId !== undefined,
                sessions: this._scopedSessions()
                    .map(s => ({ ...s, ...liveAndCleanup(s) }))
                    .sort((a, b) => b.submittedAt - a.submittedAt), // most recently added first
                draftHost: this._draftHost,
                editingId: this._editingId,
                clusterInfo: Object.fromEntries(this._clusterInfo),
                clusterErrors: this._clusterErrors,
                previewSession: this._previewSession,
            };
            view.webview.postMessage({ command: 'state', state });
            this._autoCloseIfTerminal();
        } catch (error) {
            this._logger.error('Failed to push webview state:', error);
        }
    }

    // Step 2: (re)establish the in-process relay and open a window. Step 1 (remote sshd + tunnel) is the monitor's job.
    private async _connectSessionToTunnel(sessionId: string) {
        const session = this._requireSession(sessionId, 'connect tunnel', true);
        if (!session) { return; }
        if (this._connecting.has(sessionId)) {
            this._logger.info(`Connect already in progress for session ${sessionId}; ignoring re-entrant request`);
            return;
        }
        this._connecting.add(sessionId);
        this._logger.info(`Opening window for session with ID: ${sessionId}`);
        try {
            // Already attached in this window with a live local forward - just open another window.
            if (session.status === 'connected' && session.connectionInfo?.sshTunnelForwardPort) {
                openSessionWindow(session.id);
                // windowAlive turns true once the new window registers its pid (fs.watch -> pushState).
                void this.pushState();
                return;
            }

            session.status = 'connecting';
            updateSession(session);

            await ensureRemoteSession(session); // Step 1 safety net (idempotent; usually already done by the monitor)

            // Open the local relay (reattaches from the persisted refs after a reload).
            const localPort = await connectSessionToSSHTunnel(session);

            // Key is in memory on first connect, read back from disk on reattach.
            const privateKey = session.connectionInfo?.sshPrivateKey ?? getSessionPrivateKey(session.id);
            if (!privateKey) { throw new Error('SSH private key not found for session'); }
            const hostAlias = createSSHConfigEntry(session.id, localPort, privateKey);
            this._logger.info(`SSH config entry ready for session ${session.id} (alias ${hostAlias}); ssh ${hostAlias}`);

            openSessionWindow(session.id);
            session.status = 'connected';
            updateSession(session);
            // windowAlive turns true once the new window registers its pid (fs.watch -> pushState).
            void this.pushState();
            this._logger.info(`Window opened for session ID: ${sessionId}`);
        } catch (error) {
            this._logger.error(`Error connecting tunnel for session ID ${sessionId}:`, error);
            await disposeSessionTunnelClient(sessionId); // free any partially-established relay client
            // Remote (Step 1) is still up if sshTunnelId exists - only the relay attempt failed, so
            // fall back to ready_to_connect for an easy retry; otherwise the remote is gone -> disconnected.
            session.status = session.connectionInfo?.sshTunnelId ? 'ready_to_connect' : 'disconnected';
            session.errorMessage = `Failed to connect tunnel: ${errMsg(error)}`;
            updateSession(session);
            void this.pushState();
        } finally {
            this._connecting.delete(sessionId);
        }
    }

    private async _cancelSessionExecution(sessionId: string) {
        const session = this._requireSession(sessionId, 'cancel', false);
        if (!session) { return; }

        if (session.status === 'preparing' || session.status === 'queued' || session.status === 'submitting' || session.status === 'connected' || session.status === 'disconnected' || session.status === 'ready_to_connect' || session.status === 'connecting') {
            const choice = await vscode.window.showWarningMessage(
                'Stop session?',
                { modal: true, detail: 'This cancels the running job.' },
                'Stop'
            );
            if (choice !== 'Stop') { void this.pushState(); return; }
            session.status = 'cancelling';
            session.errorMessage = '';
            cancelRunningSession(session).then(() => {
                void this.pushState();
                vscode.window.showInformationMessage('Session cancellation completed. Please check the cluster to ensure the job has been cancelled and clean up any resources if necessary.');
            }).catch(error => {
                this._logger.error(`Error cancelling session with ID ${sessionId}:`, error);
                vscode.window.showErrorMessage(`Failed to cancel session: ${errMsg(error)}. Please check the cluster to ensure the job has been cancelled and clean up any resources if necessary.`);
                session.status = 'failed';
                session.errorMessage = `Failed to cancel session: ${errMsg(error)}`;
                updateSession(session);
                void this.pushState();
            });
        } else {
            this._logger.warn(`Session with ID ${sessionId} is in status ${session.status} and cannot be cancelled.`);
            vscode.window.showWarningMessage(`Session cannot be cancelled from status: ${session.status}`);
            void this.pushState();
            return;
        }
        updateSession(session);
        void this.pushState();
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
        void this.pushState();
        launchSessionWithProgress(session).then(() => {
            this._logger.info(`Session launch completed for session ID: ${sessionId}`);
            void this.pushState();
        }).catch(error => {
            this._logger.error(`Error launching session with ID ${sessionId}:`, error);
            vscode.window.showErrorMessage(`Failed to launch session: ${errMsg(error)}. Please clean up any resources on the cluster if necessary.`);
            session.status = 'failed';
            session.errorMessage = `Failed to launch session: ${errMsg(error)}`;
            updateSession(session);
            void this.pushState();
        });
    }

    private async _prepareLaunchSession(sessionId: string) {
        const session = this._requireSession(sessionId, 'prepare launch', false);
        if (!session) { return; }

        let creds: TunnelCredential;
        try {
            creds = await getDevTunnelCredentials();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
            session.errorMessage = `Failed to get tunnel credentials: ${err.message}`;
            updateSession(session);
            this._logger.error('Failed to get tunnel credentials:', err);
            throw err;
        }
        try {
            await ensureDevTunnel(session); // persist the tunnel id before it goes into the launch script
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to create dev tunnel: ${err.message}`);
            session.errorMessage = `Failed to create dev tunnel: ${err.message}`;
            updateSession(session);
            this._logger.error('Failed to create dev tunnel:', err);
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
        void this.pushState();
    }

}
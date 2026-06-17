import * as vscode from 'vscode';
import { errMsg } from './logger';
import { SlurmClusterInfo, SlurmSession, SessionsState, WebviewMessage } from './models';
import { WebviewProvider } from './webviewProvider';
import { removeSshConfigEntry, addSshConfigEntry, getSessionPrivateKey, SshManager } from './modules/sshSupport';
import { getSlurmClusterInfo } from './modules/slurmSupport';
import { addSession, removeSession, getSession, getAllSessions, updateSession, watchSessions, liveAndCleanup } from './extensionStore';
import { connectSessionToTunnel, removeDevTunnel, disposeAllTunnelClients, disposeTunnelClient, ensureRemoteSession, getMicrosoftAccountInfo, switchDevTunnelAccount } from './modules/tunnelSupport';
import { stopSession, JobStatusMonitor, launchSession, prepareLaunch } from './modules/sessionSupport';
import { isTerminal, isCloseable, isStoppable } from './modules/sessionMachine';

function openSessionWindow(sessionId: string): void {
    const path = getSession(sessionId)?.workingDirectory ?? '';
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+cshost-${sessionId}${path}/`);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

export class SessionProvider extends WebviewProvider implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly clusterInfo = new Map<string, SlurmClusterInfo>();
    private readonly clusterErrors: Record<string, string> = {};
    private draftHost: string | null = null;
    private editingId: string | null = null;
    private previewSession: SlurmSession | null = null;
    private readonly shared: vscode.Disposable[] = [];
    private readonly connecting = new Set<string>();
    private readonly monitor = new JobStatusMonitor();
    private sharedReady = false;

    // Set in a cshost remote window (session-scoped, observe-only); undefined in the sidebar.
    constructor(extensionUri: vscode.Uri, private readonly remoteSessionId?: string) {
        super(extensionUri);
    }

    protected onResolved(): void {
        this.initSharedSubscriptions();
    }

    private initSharedSubscriptions(): void {
        if (this.sharedReady) { return; }
        this.sharedReady = true;
        this.shared.push(vscode.authentication.onDidChangeSessions((e) => {
            if (e.provider.id === 'microsoft') { void this.pushState(); }
        }));
        // A remote window re-renders only when its own session changes.
        let lastMine: string | undefined;
        const sessionsWatcher = watchSessions(() => {
            const mine = this.remoteSessionId ? JSON.stringify(getSession(this.remoteSessionId)) : undefined;
            if (mine !== undefined && mine === lastMine) { return; }
            lastMine = mine;
            void this.pushState();
        });
        this.shared.push({ dispose: () => sessionsWatcher.close() });
        // The sidebar drives monitoring; remote windows only observe.
        if (!this.remoteSessionId) {
            for (const s of getAllSessions()) {
                if (s.jobId && !isTerminal(s.status)) { this.monitor.startMonitoring(s); }
            }
        }
    }

    dispose(): void {
        this.shared.forEach(d => d.dispose());
        void disposeAllTunnelClients(); // window close: free local ports (remote stays, reaped by linkspan)
    }

    protected handleMessage(data: WebviewMessage) {
        this.logger.info('Received message from webview:', data);

        const command = data.command;
        const id = data.sessionId ?? '';
        switch (command) {
            case 'ready':
                void this.pushState();
                break;
            case 'dismissDraftSession':
                this.draftHost = null;
                void this.pushState();
                break;
            case 'dismissPreview':
                this.previewSession = null;
                void this.pushState();
                break;
            case 'addSession': {
                const now = Date.now();
                const host = data.host ?? '';
                const newSession: SlurmSession = {
                    id: `session-${now}`,
                    name: `Session ${now}`,
                    cluster: host,
                    status: 'not_started',
                    jobId: '',
                    jobDirectory: '',
                    submittedAt: now,
                    errorMessage: '',
                    workingDirectory: this.clusterInfo.get(host)?.homeDir,
                    ...this.paramsFromData(data),
                };
                addSession(newSession);
                this.draftHost = null;
                void this.pushState();
                break;
            }
            case 'editSession': {
                const s = this.requireSession(id, 'edit', true);
                if (!s) { break; }
                this.editingId = id;
                void this.pushState();
                this.fetchClusterInfo(s.cluster);
                break;
            }
            case 'dismissEditSession':
                this.editingId = null;
                void this.pushState();
                break;
            case 'saveSession': {
                const s = this.requireSession(id, 'save', true);
                if (!s) { break; }
                Object.assign(s, this.paramsFromData(data));
                s.batchScript = undefined; // params changed; the script is regenerated at launch
                updateSession(s);
                this.editingId = null;
                void this.pushState();
                break;
            }
            case 'prepareLaunchSession':
                this.prepareLaunchSession(id).catch(() => void this.pushState());
                break;
            case 'launchSession':
                this.launchSession(id);
                break;
            case 'stopSessionExecution':
                this.stopSessionExecution(id);
                break;
            case 'connectTunnel':
                void this.connectSessionToTunnel(id);
                break;
            case 'removeSession':
                this.removeSession(id);
                break;
            default:
                this.logger.warn('Unknown command from webview:', command);
        }
    }

    private requireSession(id: string, action: string, push: boolean): SlurmSession | undefined {
        const s = getSession(id);
        if (!s) {
            this.logger.error(`Session with ID ${id} not found to ${action}.`);
            vscode.window.showErrorMessage('Session not found.');
            if (push) { void this.pushState(); }
        }
        return s;
    }

    private async removeSession(sessionId: string) {
        // The webview disables this card's buttons on click, so every exit path must
        // refresh to re-enable them (or to drop the card after a successful remove).
        const session = this.requireSession(sessionId, 'remove', true);
        if (!session) { return; }

        if (!isCloseable(session.status)) {
            this.logger.warn(`Session ${sessionId} is in status ${session.status} and cannot be removed.`);
            vscode.window.showWarningMessage(`Session cannot be removed from status: ${session.status}`);
            void this.pushState();
            return;
        }

        const choice = await vscode.window.showWarningMessage(
            'Remove session?',
            {
                modal: true,
                detail: 'This removes the session record and cleans up its SSH config entry and key file.',
            },
            'Remove',
        );
        if (choice !== 'Remove') {
            void this.pushState();
            return;
        }

        await disposeTunnelClient(sessionId);
        await removeDevTunnel(session);
        try {
            removeSshConfigEntry(sessionId, `cshost-${sessionId}`);
        }
        catch (err) {
            this.logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
        }
        removeSession(sessionId);
        void this.pushState();
    }

    public async switchAccount(): Promise<void> {
        try {
            await switchDevTunnelAccount();
        }
        catch (error) {
            this.showError('Dev Tunnels sign-in failed', error);
        }
        void this.pushState();
    }

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

    public startSessionDraft(host: string): void {
        this.draftHost = host;
        void vscode.commands.executeCommand('csbridge.sessionsView.focus');
        void this.pushState();
        this.fetchClusterInfo(host);
    }

    private paramsFromData(data: WebviewMessage): Pick<SlurmSession, 'queue' | 'wallTime' | 'gpuCount' | 'gpuClass' | 'cpus' | 'memory' | 'allocation'> {
        return {
            queue: data.queue || '',
            wallTime: data.wallTime || '',
            gpuCount: data.gpu === 'None' ? 0 : 1,
            gpuClass: data.gpu ?? '',
            cpus: parseInt(data.cpus ?? '') || 0,
            memory: data.memory || '',
            allocation: data.allocation || '',
        };
    }

    private fetchClusterInfo(host: string): void {
        const cached = this.clusterInfo.get(host);
        if (cached) { void this.pushState(); return; }
        this.logger.info(`Fetching slurm cluster info for host: ${host}`);
        getSlurmClusterInfo(host).then((clusterInfo) => {
            this.clusterInfo.set(host, clusterInfo);
            delete this.clusterErrors[host];
            void this.pushState();
        }).catch((error) => {
            this.logger.error('Error fetching slurm cluster info:', error);
            this.clusterErrors[host] = errMsg(error);
            void this.pushState();
        });
    }

    private scopedSessions(): SlurmSession[] {
        return this.remoteSessionId ? getAllSessions().filter(s => s.id === this.remoteSessionId) : getAllSessions();
    }

    // closeWindow (not process.kill) so we don't tear down the SSH extension host mid-stop.
    private autoCloseIfTerminal(): void {
        if (!this.remoteSessionId) { return; }
        const s = getSession(this.remoteSessionId);
        if (s && isTerminal(s.status)) {
            vscode.commands.executeCommand('workbench.action.closeWindow');
        }
    }

    protected async pushState(): Promise<void> {
        const view = this.view;
        if (!view) { return; }
        try {
            const account = await getMicrosoftAccountInfo();
            view.description = account.label ?? 'Not Signed In';
            const state: SessionsState = {
                isRemote: this.remoteSessionId !== undefined,
                sessions: this.scopedSessions()
                    .map(s => ({ ...s, ...liveAndCleanup(s) }))
                    .sort((a, b) => b.submittedAt - a.submittedAt),
                draftHost: this.draftHost,
                editingId: this.editingId,
                clusterInfo: Object.fromEntries(this.clusterInfo),
                clusterErrors: this.clusterErrors,
                previewSession: this.previewSession,
            };
            view.webview.postMessage({ command: 'state', state });
            this.autoCloseIfTerminal();
        }
        catch (error) {
            this.logger.error('Failed to push webview state:', error);
        }
    }

    // Step 2: (re)establish the in-process relay and open a window. Step 1 (remote sshd + tunnel) is the monitor's job.
    private async connectSessionToTunnel(sessionId: string) {
        const session = this.requireSession(sessionId, 'connect tunnel', true);
        if (!session) { return; }
        if (this.connecting.has(sessionId)) {
            this.logger.info(`Connect already in progress for session ${sessionId}; ignoring re-entrant request`);
            return;
        }
        this.connecting.add(sessionId);
        try {
            // Already attached in this window with a live local forward - just open another window.
            if (session.status === 'connected' && session.connectionInfo?.sshTunnelForwardPort) {
                openSessionWindow(session.id);
                void this.pushState();
                return;
            }

            this.setStatus(session, 'connecting');
            await ensureRemoteSession(session); // Step 1 safety net (idempotent; usually already done by the monitor)
            const localPort = await connectSessionToTunnel(session);

            // Key is in memory on first connect, read back from disk on reattach.
            const privateKey = session.connectionInfo?.sshPrivateKey ?? getSessionPrivateKey(session.id);
            if (!privateKey) { throw new Error('SSH private key not found for session'); }
            const hostAlias = addSshConfigEntry(session.id, localPort, privateKey);
            this.logger.info(`SSH config entry ready for session ${session.id} (ssh ${hostAlias})`);

            openSessionWindow(session.id);
            this.setStatus(session, 'connected');
            // windowAlive turns true once the new window registers its pid (fs.watch -> pushState).
            void this.pushState();
        }
        catch (error) {
            this.logger.error(`Error connecting tunnel for session ${sessionId}:`, error);
            await disposeTunnelClient(sessionId);
            // Step 1 still up (sshTunnelId persisted) -> only the relay failed: ready_to_connect for retry; else the remote is gone -> disconnected.
            this.setStatus(session, session.connectionInfo?.sshTunnelId ? 'ready_to_connect' : 'disconnected', `Failed to connect tunnel: ${errMsg(error)}`);
            void this.pushState();
        }
        finally {
            this.connecting.delete(sessionId);
        }
    }

    private async stopSessionExecution(sessionId: string) {
        const session = this.requireSession(sessionId, 'stop', false);
        if (!session) { return; }

        if (!isStoppable(session.status)) {
            this.logger.warn(`Session with ID ${sessionId} is in status ${session.status} and cannot be stopped.`);
            vscode.window.showWarningMessage(`Session cannot be stopped from status: ${session.status}`);
            void this.pushState();
            return;
        }

        const choice = await vscode.window.showWarningMessage(
            'Stop session?',
            { modal: true, detail: 'This stops the running job.' },
            'Stop',
        );
        if (choice !== 'Stop') { void this.pushState(); return; }

        this.setStatus(session, 'stopping', '');
        void this.pushState();
        const hint = 'Please check the cluster to ensure the job has stopped and clean up any resources if necessary.';
        this.runSessionTask(session, `Stopping session ${session.name}...`, 'stop',
            p => stopSession(session, this.monitor, p), hint, `Session stopped. ${hint}`);
    }

    private launchSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'launch', false);
        if (!session) { return; }
        this.previewSession = null;
        session.connectionInfo = undefined;
        session.startedAt = undefined; // fresh launch: re-anchor the wall-time countdown when the new job starts running
        this.setStatus(session, 'submitting', '');
        void this.pushState();
        this.runSessionTask(session, `Launching session ${session.name}...`, 'launch',
            p => launchSession(session, this.monitor, p), 'Please clean up any resources on the cluster if necessary.');
    }

    private setStatus(session: SlurmSession, status: SlurmSession['status'], errorMessage?: string): void {
        session.status = status;
        if (errorMessage !== undefined) { session.errorMessage = errorMessage; }
        updateSession(session);
    }

    // Dismissing the progress notification marks the session stopped; a failure marks it failed and shows a dialog.
    private runSessionTask(session: SlurmSession, title: string, verb: string, run: (progress: vscode.Progress<{ message?: string }>) => Promise<void>, cleanupHint: string, successMessage?: string): void {
        const task = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
            token.onCancellationRequested(() => this.setStatus(session, 'stopped'));
            await run(progress);
        });
        Promise.resolve(task).then(() => {
            void this.pushState();
            if (successMessage) { vscode.window.showInformationMessage(successMessage); }
        }).catch((error) => {
            const detail = `Failed to ${verb} session: ${errMsg(error)}`;
            this.logger.error(`${detail} (id ${session.id})`, error);
            vscode.window.showErrorMessage(`${detail}. ${cleanupHint}`);
            this.setStatus(session, 'failed', detail);
            void this.pushState();
        });
    }

    private async prepareLaunchSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'prepare launch', false);
        if (!session) { return; }
        try {
            await prepareLaunch(session);
        }
        catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            session.errorMessage = errMsg(err);
            updateSession(session);
            this.logger.error('Failed to prepare session launch:', err);
            throw err; // the dispatch's .catch re-pushes state so the card shows the error
        }
        this.previewSession = session;
        void this.pushState();
    }
}

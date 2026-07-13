import * as vscode from 'vscode';
import { uuidv7 } from 'uuidv7';
import { errMsg } from './logger';
import { HostRuntime, SlurmSession, SessionsState, WebviewMessage, PromptObserver, PromptCancelledError } from './models';
import { WebviewProvider } from './webviewProvider';
import { removeSshConfigEntry, addSshConfigEntry, getSessionPrivateKey, SshManager } from './modules/sshSupport';
import { getSlurmClusterInfo } from './modules/slurmSupport';
import { csHostAlias } from './modules/sshHostsStore';
import { addSession, removeSession, getSession, getAllSessions, updateSession, watchSessions, liveAndCleanup } from './extensionStore';
import { connectSessionToTunnel, removeDevTunnel, disposeAllTunnelClients, disposeTunnelClient, ensureRemoteSession, getMicrosoftAccountInfo, hasActiveTunnelClient, switchDevTunnelAccount } from './modules/tunnelSupport';
import { stopSession, SessionMonitor, launchSession, prepareLaunch } from './modules/sessionSupport';
import { validateSlurmConfig } from './modules/slurmLaunch';
import { isTerminal, isCloseable, isStoppable, isReattachable, isWallTimeExpired } from './modules/sessionMachine';

// forceNew=false relies on VS Code deduping by workspace identity: it focuses the window already holding this URI.
function openSessionWindow(sessionId: string, forceNew: boolean): void {
    const session = getSession(sessionId);
    const path = session?.workingDirectory ?? '';
    // Authority suffix == the ssh_config Host alias VS Code runs `ssh` against and shows as the "[SSH: …]" label.
    const suffix = csHostAlias(session?.cluster ?? '', session?.name ?? sessionId);
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${suffix}${path}/`);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: forceNew });
}

export class SessionProvider extends WebviewProvider implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly hostRuntime = new Map<string, HostRuntime>();
    private draftHost: string | null = null;
    private editingId: string | null = null;
    private previewSession: SlurmSession | null = null;
    private readonly shared: vscode.Disposable[] = [];
    private readonly connecting = new Set<string>();
    private readonly opening = new Set<string>();
    private readonly monitor = new SessionMonitor();
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
    }

    // At activation (sidebar only): resume monitoring and rebuild the relay (gone after restart) for every live-backend session.
    public async reattachLiveSessions(): Promise<void> {
        if (this.remoteSessionId) { return; }
        for (const s of getAllSessions()) {
            if (s.jobId && !isTerminal(s.status)) { this.monitor.startMonitoring(s); }
        }
        if ((await getMicrosoftAccountInfo()).label === null) { return; } // don't force a sign-in popup at startup
        for (const s of getAllSessions()) {
            // Relaying an expired session would only flash "connecting…" then fail back; leave it for the monitor.
            if (isReattachable(s.status, !!s.connectionInfo?.sshTunnelId) && !hasActiveTunnelClient(s.id) && !isWallTimeExpired(s, Date.now())) {
                void this.establishRelay(s);
            }
        }
    }

    dispose(): void {
        this.monitor.dispose(); // window close: clear every per-session poll interval so none leak past teardown
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
            case 'dismissAlert':
                this.alert = null;
                void this.pushState();
                break;
            case 'addSession': {
                const now = Date.now();
                const host = data.host ?? '';
                const runtime = this.hostRuntime.get(host);
                const newSession: SlurmSession = {
                    id: uuidv7(), // time-ordered, so sorting by id is creation order
                    name: `${now}`,
                    cluster: host,
                    status: 'not_started',
                    jobId: '',
                    jobDirectory: '',
                    submittedAt: now,
                    errorMessage: '',
                    workingDirectory: runtime?.phase === 'ready' ? runtime.info.homeDir : undefined,
                    ...this.paramsFromData(data),
                };
                void this.validateThenPersist(newSession, () => {
                    addSession(newSession);
                    this.draftHost = null;
                });
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
            case 'retryClusterInfo':
                this.fetchClusterInfo(data.host ?? '');
                break;
            case 'saveSession': {
                const s = this.requireSession(id, 'save', true);
                if (!s) { break; }
                // copy: a rejected edit must not touch the stored session
                const updated = { ...s, ...this.paramsFromData(data), batchScript: undefined };
                void this.validateThenPersist(updated, () => {
                    updateSession(updated);
                    this.editingId = null;
                });
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
            case 'stopRemoteSession': // remote-window card Stop → same scancel + swap-to-local + summary as the status-bar Stop
                if (this.remoteSessionId) { void vscode.commands.executeCommand('csbridge.stopRemoteSession'); }
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
            removeSshConfigEntry(sessionId, csHostAlias(session.cluster, session.name));
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

    private validating = false;
    private alert: SessionsState['alert'] = null;

    private async validateThenPersist(session: SlurmSession, persist: () => void): Promise<void> {
        if (this.validating) { return; }
        this.validating = true;
        void this.pushState();
        try {
            await validateSlurmConfig(session, SshManager.getInstance(), this.logger);
            persist();
        }
        catch (err) {
            this.logger.error('Session validation failed:', err);
            this.alert = { title: 'Session validation failed', message: errMsg(err) };
        }
        finally {
            this.validating = false;
            void this.pushState();
        }
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

    private setHostRuntime(host: string, runtime: HostRuntime): void {
        this.hostRuntime.set(host, runtime);
        void this.pushState();
    }

    private fetchClusterInfo(host: string): void {
        if (this.hostRuntime.get(host)?.phase === 'ready') { void this.pushState(); return; }
        this.logger.info(`Fetching slurm cluster info for host: ${host}`);
        this.setHostRuntime(host, { phase: 'loading' });
        // The auth box (if any) surfaces during the fetch: reflect it on the draft form, treat a dismiss as an interruption.
        const observer: PromptObserver = e => this.setHostRuntime(host, { phase: e === 'opened' ? 'awaiting' : 'loading' });
        getSlurmClusterInfo(host, observer)
            .then(info => this.setHostRuntime(host, { phase: 'ready', info }))
            .catch((error) => {
                this.logger.error('Error fetching slurm cluster info:', error);
                this.setHostRuntime(host, { phase: 'error', message: error instanceof PromptCancelledError ? 'Interrupted — input dismissed' : errMsg(error) });
            });
    }

    private scopedSessions(): SlurmSession[] {
        return this.remoteSessionId ? getAllSessions().filter(s => s.id === this.remoteSessionId) : getAllSessions();
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
                    .map((s) => {
                        const live = liveAndCleanup(s);
                        if (live.windowAlive) { this.opening.delete(s.id); }
                        return { ...s, ...live, opening: this.opening.has(s.id) };
                    })
                    // newest first (uuidv7 ids are time-ordered)
                    .sort((a, b) => b.id.localeCompare(a.id)),
                draftHost: this.draftHost,
                editingId: this.editingId,
                hostRuntime: Object.fromEntries(this.hostRuntime),
                previewSession: this.previewSession,
                validating: this.validating,
                alert: this.alert,
            };
            view.webview.postMessage({ command: 'state', state });
        }
        catch (error) {
            this.logger.error('Failed to push webview state:', error);
        }
    }

    // Step 2 core: (re)build the in-process relay from the persisted refs. No window — reattach and connect share this.
    private async establishRelay(session: SlurmSession): Promise<boolean> {
        if (this.connecting.has(session.id)) {
            this.logger.info(`Connect already in progress for session ${session.id}; ignoring re-entrant request`);
            return false;
        }
        this.connecting.add(session.id);
        try {
            this.setStatus(session, 'connecting');
            await ensureRemoteSession(session); // idempotent; refreshes tunnel creds for reattach
            const localPort = await connectSessionToTunnel(session);
            // These awaits can run tens of seconds against a dead node; if the monitor terminalized meanwhile (session
            // auto-refreshes in place), drop the relay rather than overwrite its verdict.
            if (isTerminal(session.status) || isWallTimeExpired(session, Date.now())) {
                await disposeTunnelClient(session.id);
                return false;
            }
            const privateKey = session.connectionInfo?.sshPrivateKey ?? getSessionPrivateKey(session.id);
            if (!privateKey) { throw new Error('SSH private key not found for session'); }
            const hostAlias = addSshConfigEntry(session, localPort, privateKey);
            this.logger.info(`SSH config entry ready for session ${session.id} (ssh ${hostAlias})`);
            this.setStatus(session, 'connected');
            return true;
        }
        catch (error) {
            this.logger.error(`Error establishing relay for session ${session.id}:`, error);
            await disposeTunnelClient(session.id);
            // Same terminal guard as the success path: don't resurrect a session the monitor stopped mid-connect.
            if (!isTerminal(session.status)) {
                // Step 1 still up (sshTunnelId persisted) -> relay-only failure, retry from ready_to_connect; else unreachable.
                this.setStatus(session, session.connectionInfo?.sshTunnelId ? 'ready_to_connect' : 'unreachable', `Failed to connect tunnel: ${errMsg(error)}`);
            }
            return false;
        }
        finally {
            this.connecting.delete(session.id);
        }
    }

    // 'opening' holds the card's spinner until the new window's extension registers a windowPid (60s fallback).
    private openOrFocusWindow(session: SlurmSession): void {
        if (liveAndCleanup(session).windowAlive) { return openSessionWindow(session.id, false); }
        this.opening.add(session.id);
        setTimeout(() => { if (this.opening.delete(session.id)) { void this.pushState(); } }, 60_000);
        openSessionWindow(session.id, true);
    }

    private async connectSessionToTunnel(sessionId: string) {
        const session = this.requireSession(sessionId, 'connect tunnel', true);
        if (!session) { return; }
        // Stale Connect/Switch on an expired session: stop it (the monitor terminal-guard untracks) instead of a doomed relay.
        if (isWallTimeExpired(session, Date.now())) {
            this.setStatus(session, 'stopped', '');
            await disposeTunnelClient(session.id);
            vscode.window.showInformationMessage('This session was stopped at its wall-time limit. Restart it to run again.');
            void this.pushState();
            return;
        }
        // Already connected with a live remote window — this window's own, or another sidebar's (windowAlive reads the
        // shared windowPids). Just focus it; a second relay to the same tunnel is redundant and fights the first.
        if (session.status === 'connected' && (liveAndCleanup(session).windowAlive || session.connectionInfo?.sshTunnelForwardPort)) {
            this.openOrFocusWindow(session);
            void this.pushState();
            return;
        }
        if (await this.establishRelay(session)) { this.openOrFocusWindow(session); }
        void this.pushState();
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
        this.runSessionTask(session, `Stopping Session ${session.name}...`, 'stop',
            p => stopSession(session, this.monitor, p), hint, `Session stopped. ${hint}`);
    }

    private launchSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'launch', false);
        if (!session) { return; }
        this.previewSession = null;
        session.startedAt = undefined; // fresh launch: re-anchor the wall-time countdown when the new job starts running
        this.setStatus(session, 'submitting', '');
        void this.pushState();
        // An SSH auth box during launch shows on the card as awaiting_input, reverting to submitting once answered.
        const observer: PromptObserver = (e) => { this.setStatus(session, e === 'opened' ? 'awaiting_input' : 'submitting'); void this.pushState(); };
        this.runSessionTask(session, `Launching Session ${session.name}...`, 'launch',
            p => launchSession(session, this.monitor, p, observer), 'Please clean up any resources on the cluster if necessary.');
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
            if (error instanceof PromptCancelledError) { // a deliberate dismiss, not a failure: offer Retry, no error dialog
                this.setStatus(session, 'interrupted', '');
                void this.pushState();
                return;
            }
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

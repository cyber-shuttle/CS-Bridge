import * as vscode from 'vscode';
import { uuidv7 } from 'uuidv7';
import { errMsg } from './logger';
import { HostRuntime, Metric, POLLING_INTERVAL_MS, SlurmSession, SessionsState, WebviewMessage } from './models';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { removeSshConfigEntry, addSshConfigEntry, createSessionKeyPair, SshManager } from './modules/sshSupport';
import { getSlurmClusterInfo } from './modules/slurmSupport';
import { csHostAlias } from './modules/sshHostsStore';
import { addSession, removeSession, getSession, getAllSessions, setStatus, watchSessions } from './extensionStore';
import { CONTROL_WS_URL, Control, ControlError, toMetrics } from './control';
import { stopSession, launchSession, trackSessions } from './modules/sessionSupport';
import { validateSlurmConfig } from './modules/slurmLaunch';
import { slurmAccount } from './modules/slurmParse';
import { isCloseable, isStoppable, isRelayLive } from './modules/sessionMachine';

function openSessionWindow(session: SlurmSession): void {
    const path = session.workingDirectory ?? '';
    // Authority suffix == the ssh_config Host alias VS Code runs `ssh` against and shows as the "[SSH: …]" label.
    const suffix = csHostAlias(session.cluster, session.planeId ?? '');
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${suffix}${path}/`);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
}

export class SessionProvider extends WebviewProvider implements vscode.Disposable {
    public static readonly viewType = 'csbridge.sessionsView';
    protected readonly viewKind = 'sessions' as const;

    private readonly hostRuntime = new Map<string, HostRuntime>();
    private draftHost: string | null = null;
    private account: string | undefined;
    private readonly metrics = new Map<string, Metric[]>();
    private readonly connecting = new Set<string>();
    private readonly timer: ReturnType<typeof setInterval>;
    private readonly watcher = watchSessions(() => void this.pushState());

    // Set in a remote window (session-scoped, observe-only); undefined in the sidebar, which alone tracks jobs.
    constructor(extensionUri: vscode.Uri, private readonly control: Control, private readonly remoteSessionId?: string) {
        super(extensionUri);
        control.onDidChange(() => void this.refresh());
        this.timer = setInterval(() => void this.refresh(), POLLING_INTERVAL_MS);
        void this.refresh();
    }

    dispose(): void {
        clearInterval(this.timer);
        this.watcher.close();
    }

    private refreshing = false;

    private async refresh(): Promise<void> {
        if (this.refreshing) { return; } // a slow login node must not stack polls in the per-host ssh queue
        this.refreshing = true;
        try {
            this.account = await this.control.accountName();
            if (this.account) {
                if (!this.remoteSessionId) { await trackSessions(this.control); }
                await Promise.all(this.scopedSessions().filter(s => s.planeId && isRelayLive(s.status)).map(async (s) => {
                    this.metrics.set(s.id, toMetrics(await this.control.sessionMetrics(s.planeId!).catch(() => [])));
                }));
            }
        }
        finally { this.refreshing = false; }
        void this.pushState();
    }

    // A dismissal only clears one field, so each is named by the field it clears.
    private readonly dismissals: Record<string, () => void> = {
        dismissDraftSession: () => { this.draftHost = null; },
        dismissAlert: () => { this.alert = null; },
    };

    private readonly handlers: Record<string, (data: WebviewMessage, id: string) => void> = {
        ready: () => void this.pushState(),
        signIn: () => void vscode.commands.executeCommand('csbridge.signIn'),
        addSession: data => this.createSession(data),
        refreshClusterInfo: data => this.fetchClusterInfo(data.host ?? '', true),
        launchSession: (_data, id) => this.submitSession(id),
        stopSessionExecution: (_data, id) => this.stopSessionExecution(id),
        stopRemoteSession: () => {
            if (this.remoteSessionId) { void vscode.commands.executeCommand('csbridge.stopRemoteSession'); }
        },
        connectTunnel: (_data, id) => void this.connectSession(id),
        removeSession: (_data, id) => this.confirmAndRemoveSession(id),
    };

    protected handleMessage(data: WebviewMessage) {
        this.logger.info('Received message from webview:', data);
        const dismiss = this.dismissals[data.command];
        if (dismiss) {
            dismiss();
            void this.pushState();
            return;
        }
        const handler = this.handlers[data.command];
        if (!handler) {
            this.logger.warn('Unknown command from webview:', data.command);
            return;
        }
        handler(data, data.sessionId ?? '');
    }

    private createSession(data: WebviewMessage): void {
        const now = Date.now();
        const host = data.host ?? '';
        const runtime = this.hostRuntime.get(host);
        const session: SlurmSession = {
            id: uuidv7(), // time-ordered, so sorting by id is creation order
            name: `${now}`,
            cluster: host,
            status: 'not_started',
            jobId: '',
            submittedAt: now,
            errorMessage: '',
            workingDirectory: runtime?.phase === 'ready' ? runtime.info.homeDir : undefined,
            ...this.paramsFromData(data),
        };
        void this.validateThenPersist(session, () => {
            addSession(session);
            this.draftHost = null;
        });
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

    private async confirmAndRemoveSession(sessionId: string) {
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

        const confirmed = await confirmModal('Remove session?', 'Remove',
            'This removes the session record and cleans up its SSH config entry and key file.');
        if (!confirmed) {
            void this.pushState();
            return;
        }

        try {
            await removeSshConfigEntry(sessionId, csHostAlias(session.cluster, session.planeId ?? session.name.slice(-6)));
            // Stop first: cs-plane deletes only a stopped session, and a lost stop would leave it live.
            const planeId = session.planeId;
            await (planeId && this.control.stopSession(planeId).then(() => this.control.deleteSession(planeId)).catch((err) => {
                if (!(err instanceof ControlError && err.status === 404)) { throw err; }
            }));
        }
        catch (err) {
            this.logger.error(`Failed to clean up session ${sessionId}:`, err);
        }
        removeSession(sessionId);
        void this.pushState();
    }

    public async startNewSession(): Promise<void> {
        if (!this.account) { return void vscode.commands.executeCommand('csbridge.signIn'); }
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
            allocation: slurmAccount(data.allocation),
        };
    }

    private setHostRuntime(host: string, runtime: HostRuntime): void {
        this.hostRuntime.set(host, runtime);
        void this.pushState();
    }

    private fetchClusterInfo(host: string, force = false): void {
        if (!force && this.hostRuntime.get(host)?.phase === 'ready') { void this.pushState(); return; }
        this.logger.info(`Fetching Slurm cluster info for host: ${host}`);
        this.setHostRuntime(host, { phase: 'loading' });
        getSlurmClusterInfo(host)
            .then(info => this.setHostRuntime(host, { phase: 'ready', info }))
            .catch((error) => {
                this.logger.error('Error fetching Slurm cluster info:', error);
                this.setHostRuntime(host, { phase: 'error', message: errMsg(error) });
            });
    }

    private scopedSessions(): SlurmSession[] {
        return this.remoteSessionId ? getAllSessions().filter(s => s.id === this.remoteSessionId) : getAllSessions();
    }

    protected async pushState(): Promise<void> {
        const view = this.view;
        if (!view) { return; }
        try {
            view.description = this.account ?? 'Not Signed In';
            const state: SessionsState = {
                isRemote: this.remoteSessionId !== undefined,
                account: this.account,
                sessions: this.scopedSessions()
                    .map((s) => {
                        const status = this.connecting.has(s.id) ? 'connecting' : s.id === this.remoteSessionId && s.status === 'ready_to_connect' ? 'connected' : s.status;
                        return { ...s, status, metrics: this.metrics.get(s.id) };
                    })
                    // newest first (uuidv7 ids are time-ordered)
                    .sort((a, b) => b.id.localeCompare(a.id)),
                draftHost: this.draftHost,
                hostRuntime: Object.fromEntries(this.hostRuntime),
                validating: this.validating,
                alert: this.alert,
            };
            view.webview.postMessage({ command: 'state', state });
        }
        catch (error) {
            this.logger.error('Failed to push webview state:', error);
        }
    }

    private async connectSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'connect tunnel', true);
        if (!session || this.connecting.has(sessionId)) { return; }
        this.connecting.add(sessionId);
        void this.pushState();
        try {
            if (!session.planeId) { throw new Error('This session was started by an older CS Bridge; stop it and start it again.'); }
            const { jupyter } = await this.control.sessionAccess(session.planeId);
            const { port } = await this.control.sessionSsh(session.planeId, createSessionKeyPair(session.id));
            const hostAlias = await addSshConfigEntry(session, `${CONTROL_WS_URL}/sessions/${session.planeId}/forward/${port}`, jupyter.token);
            this.logger.info(`SSH config entry ready for session ${session.id} (ssh ${hostAlias})`);
            openSessionWindow(session);
        }
        catch (error) {
            this.logger.error(`Error connecting session ${session.id}:`, error);
            vscode.window.showErrorMessage(`Failed to connect: ${errMsg(error)}`);
        }
        finally {
            this.connecting.delete(sessionId);
            void this.pushState();
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

        if (!await confirmModal('Stop session?', 'Stop', 'This stops the running job.')) { void this.pushState(); return; }

        setStatus(session, 'stopping', '');
        void this.pushState();
        this.finishInterruptedStop(session);
    }

    // The real stop (via stopSession), shared by the sidebar Stop and the summary consumer finishing a handed-off session.
    public finishInterruptedStop(session: SlurmSession): void {
        this.runSessionTask(session, 'stop', () => stopSession(session, this.control),
            'Please check the cluster to ensure the job has stopped and clean up any resources if necessary.');
    }

    private submitSession(sessionId: string) {
        const session = this.requireSession(sessionId, 'launch', false);
        if (!session) { return; }
        session.startedAt = undefined; // fresh launch: re-anchor the wall-time countdown when the new job starts running
        setStatus(session, 'submitting', '');
        void this.pushState();
        this.runSessionTask(session, 'launch', () => launchSession(session, this.control),
            'Please clean up any resources on the cluster if necessary.');
    }

    // A failure marks the session failed and shows a dialog.
    private runSessionTask(session: SlurmSession, verb: string, run: () => Promise<void>, cleanupHint: string): void {
        run().then(() => {
            void this.pushState();
        }).catch((error) => {
            const detail = `Failed to ${verb} session: ${errMsg(error)}`;
            this.logger.error(`${detail} (id ${session.id})`, error);
            vscode.window.showErrorMessage(`${detail}. ${cleanupHint}`);
            setStatus(session, 'failed', detail);
            void this.pushState();
        });
    }
}

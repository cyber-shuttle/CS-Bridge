import * as vscode from 'vscode';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { MetricsCollector } from './instrumentation/index.js';
import { getSshHosts, SshManager } from './SshManager.js';
import { TunnelManager, TunnelCredentials } from './TunnelManager.js';
import { StorageBrowserManager } from './StorageBrowserManager.js';
import { DataCache } from './vfs/DataCache.js';
import { SyncProvider } from './vfs/SyncProvider.js';
import { MountProvider } from './vfs/MountProvider.js';
import { LocalLinkspanManager } from './LocalLinkspan.js';
import { getStoragesHtml } from './views/storageView.js';
import { allRuntimes, detectActiveSession, findRuntime, getVisibleWorkspaces, Runtime, Workspace } from './WorkspaceManager.js';
import { getSessionsHtml } from './views/sessionsView.js';
import { queryAssociations, saveHostPrefs } from './SLURMManager.js';
import { CSExtensionContext } from './ExtensionContext.js';
import { clearSessionFields, loadSessions, mergeSessionsFromFile, saveSessions } from './SessionManager.js';
import { ensureLocalLinkspan, launchLinkspanProcess, pollLinkspanWorkflow } from './LinkspanManager.js';

/**
 * Generate the linkspan workflow YAML for a given tunnel name.
 * Uses provider-agnostic tunnel.create / tunnel.connect actions.
 */
function generateLinkspanWorkflow(tunnelName: string, provider: string, serverUrl?: string, filesystemSync = true): string {
    const serverUrlLine = serverUrl ? `\n      server_url: "${serverUrl}"` : '';
    const steps: string[] = [
        `name: "cs-bridge-hpc-setup"`,
        ``,
        `steps:`,
        `  - action: "tunnel.create"`,
        `    name: "Create remote tunnel"`,
        `    params:`,
        `      provider: "${provider}"`,
        `      tunnel_name: "${tunnelName}"`,
        `      expiration: "1d"`,
        `      auth_token: "{{.TunnelAuthToken}}"${serverUrlLine}`,
        `      server_port: "{{.ServerPort}}"`,
        `      ssh_port: "{{.SshPort}}"`,
        `      log_port: "{{.LogPort}}"`,
        `    outputs:`,
        `      tunnel_id: "tunnel_id"`,
        `      connection_url: "tunnel_url"`,
        `      token: "tunnel_token"`,
        `      ssh_port: "ssh_port"`,
        `      log_port: "log_port"`,
    ];

    if (filesystemSync) {
        steps.push(
            ``,
            `  - action: "tunnel.connect"`,
            `    name: "Connect to local tunnel"`,
            `    params:`,
            `      provider: "${provider}"`,
            `      tunnel_id: "{{.LocalTunnelID}}"`,
            `      access_token: "{{.LocalTunnelToken}}"`,
            `      ssh_port: "{{.LocalSshPort}}"`,
            `    outputs:`,
            `      port_map: "local_port_map"`,
            `      mapped_ssh_port: "mapped_ssh_port"`,
            ``,
            `  - action: "mount.setup_overlay"`,
            `    name: "Set up overlay filesystem"`,
            `    params:`,
            `      session_id: "{{.SessionID}}"`,
            `      local_ssh_port: "{{.mapped_ssh_port}}"`,
            `      local_workspace: "{{.LocalWorkspace}}"`,
        );
    }

    return steps.join('\n');
}


export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly sessionsViewType = 'cybershuttle.sessionsView';
    public static readonly storagesViewType = 'cybershuttle.storagesView';

    private _sessionsView?: vscode.WebviewView;
    private _storagesView?: vscode.WebviewView;

    private ctx: CSExtensionContext;

    public readonly isRemoteWindow: boolean;


    private get _filesystemSyncEnabled(): boolean {
        return vscode.workspace.getConfiguration('cybershuttle').get('enableFilesystemSync', true);
    }

    private _getOrCreateWorkspace(dirPath: string): Workspace {
        let ws = this.ctx.workspaces.find(w => w.directoryPath === dirPath);
        if (!ws) {
            ws = {
                id: crypto.randomBytes(4).toString('hex'),
                directoryPath: dirPath,
                directoryName: dirPath === 'unknown' ? 'No Folder' : (path.basename(dirPath) || dirPath),
                runtimes: [],
            };
            this.ctx.workspaces.push(ws);
        }
        return ws;
    }

    constructor(private readonly _extensionUri: vscode.Uri, workspaceState: vscode.Memento, metrics: MetricsCollector) {

        const oc = vscode.window.createOutputChannel('CyberShuttle');
        const ssh = new SshManager(this._extensionUri, oc, metrics);
        const dc = new DataCache(oc);
        const tm = new TunnelManager(oc, metrics);

        this.ctx = {
            workspaces: new Array<Workspace>(),
            windowId: '',
            metrics: metrics,
            workspaceState: workspaceState,
            outputChannel: oc,
            ssh: ssh,
            tunnelManager: tm,
            storageBrowser: new StorageBrowserManager(ssh, (msg: unknown) => this._postStoragesMessage(msg)),
            dataCache: dc,
            syncProvider: new SyncProvider(dc, oc),
            mountProvider: new MountProvider(dc, oc),
            localLinkspan: new LocalLinkspanManager(oc, () => ensureLocalLinkspan(this.ctx), () => tm.getCredentials()),
            sshControlDir: path.join(os.homedir(), '.cs-ssh'),
            statusBarItem: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100),
            internalSshConfigPath: path.join(os.homedir(), '.cybershuttle', 'ssh_config'),
        } as CSExtensionContext;

        this.ctx.tunnelManager.onAuthStateChanged = (account) => this.postAuthState(account);

        this.ctx.localLinkspan.killStaleProcesses();
        // Short path to stay under macOS 104-byte Unix socket limit
        if (!fs.existsSync(this.ctx.sshControlDir)) {
            fs.mkdirSync(this.ctx.sshControlDir, { mode: 0o700 });
        }
        // File-based session storage for cross-window sync
        const csDir = path.join(os.homedir(), '.cybershuttle');
        if (!fs.existsSync(csDir)) {
            fs.mkdirSync(csDir, { mode: 0o700 });
        }
        this.ctx.sessionsFilePath = path.join(csDir, 'sessions.json');
        // Detect if this window is a Remote-SSH window
        const folder = vscode.workspace.workspaceFolders?.[0];
        this.isRemoteWindow = folder?.uri.scheme === 'vscode-remote';

        // Set navy blue title bar in remote windows for visual distinction
        if (this.isRemoteWindow) {
            const config = vscode.workspace.getConfiguration('workbench');
            const colors: any = config.get('colorCustomizations') || {};
            if (!colors['titleBar.activeBackground']) {
                config.update('colorCustomizations', {
                    ...colors,
                    'titleBar.activeBackground': '#001f3f',
                    'titleBar.activeForeground': '#ffffff',
                    'titleBar.inactiveBackground': '#001a33',
                    'titleBar.inactiveForeground': '#cccccc',
                }, vscode.ConfigurationTarget.Workspace);
            }
        }

        // Status bar item for active session countdown
        loadSessions(this.ctx, this.refresh.bind(this));
        this.refresh();
        this._watchSessionsFile();
        this._updateStatusBar();

        // Generate or retrieve a stable window ID for this VS Code window
        this.ctx.windowId = this.ctx.workspaceState.get<string>('cybershuttle.windowId') || crypto.randomBytes(8).toString('hex');
        this.ctx.workspaceState.update('cybershuttle.windowId', this.ctx.windowId);

        // Auto-register this window as a Local session
        this._registerWindow();

        // Auto-start local linkspan (non-blocking, with retry)
        this._autoStartLinkspan();

        // Heartbeat every 30s to keep this window's session alive
        this.ctx.heartbeatTimer = setInterval(() => this._heartbeat(), 30_000);

        // When workspace folder changes, re-register to fix 'unknown' workspace names
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this._registerWindow();
            this.refresh();
        });
    }

    private _mergeDebounceTimer?: ReturnType<typeof setTimeout>;

    private _watchSessionsFile() {
        fs.watchFile(this.ctx.sessionsFilePath, { interval: 2000 }, () => {
            // Skip if this window wrote recently (within 5s)
            if (Date.now() - this.ctx.lastWriteTime < 5000) {
                return;
            }
            // Debounce rapid external changes into a single merge
            if (this._mergeDebounceTimer) { clearTimeout(this._mergeDebounceTimer); }
            this._mergeDebounceTimer = setTimeout(() => {
                this._mergeDebounceTimer = undefined;
                this.ctx.outputChannel.appendLine('[sessions] Sessions file changed externally, merging');
                mergeSessionsFromFile(this.ctx);
                this._sendRuntimeUpdates();
                this._updateStatusBar();
            }, 1000);
        });
    }

    /**
     * Register this VS Code window as a Local session if not already present.
     */
    private _registerWindow() {
        // If this is a remote window connected to an existing session, claim that
        // runtime instead of creating a new Local runtime. This prevents duplicate
        // session cards when switching to a remote runtime.
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder?.uri.scheme === 'vscode-remote') {
            const authority = folder.uri.authority;
            // Match cs-tunnel-{id} (local linkspan) or cs-session-{id} (remote SLURM)
            const match = authority.match(/^ssh-remote\+cs-(?:tunnel|session)-(.+)$/);
            if (match) {
                const sessionId = match[1];
                for (const w of this.ctx.workspaces) {
                    const rt = w.runtimes.find(r => r.id === sessionId);
                    if (rt) {
                        rt.windowId = this.ctx.windowId;
                        rt.heartbeat = Date.now();
                        saveSessions(this.ctx);
                        return;
                    }
                }
            }
        }

        const dirPath = folder
            ? (folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString())
            : 'unknown';

        let existing: { workspace: Workspace; runtime: Runtime } | undefined;
        for (const w of this.ctx.workspaces) {
            const rt = w.runtimes.find(r => r.windowId === this.ctx.windowId);
            if (rt) { existing = { workspace: w, runtime: rt }; break; }
        }

        if (existing) {
            existing.runtime.heartbeat = Date.now();
            // If workspace path has changed (or was 'unknown'), move the runtime to the correct workspace
            if (existing.workspace.directoryPath !== dirPath && dirPath !== 'unknown') {
                existing.workspace.runtimes = existing.workspace.runtimes.filter(r => r.windowId !== this.ctx.windowId);
                if (existing.workspace.runtimes.length === 0) {
                    this.ctx.workspaces = this.ctx.workspaces.filter(w => w.id !== existing!.workspace.id);
                }
                const ws = this._getOrCreateWorkspace(dirPath);
                ws.runtimes.push(existing.runtime);
            } else if (dirPath === 'unknown') {
                // Window no longer has a folder open — remove this Local runtime
                existing.workspace.runtimes = existing.workspace.runtimes.filter(r => r.windowId !== this.ctx.windowId);
                if (existing.workspace.runtimes.length === 0) {
                    this.ctx.workspaces = this.ctx.workspaces.filter(w => w.id !== existing!.workspace.id);
                }
            }
            saveSessions(this.ctx);
            return;
        }

        // Only create a new Local runtime for non-remote windows that have a folder open
        if (this.isRemoteWindow || dirPath === 'unknown') {
            return;
        }

        const ws = this._getOrCreateWorkspace(dirPath);

        // Reclaim a detached Local runtime for this workspace (e.g. after switching
        // to remote and back — the original Local runtime's windowId was cleared by
        // stale heartbeat pruning, so we reclaim it instead of creating a duplicate).
        const detached = ws.runtimes.find(r => !r.windowId && r.status === 'Local' && !r.slurmJobId);
        if (detached) {
            detached.windowId = this.ctx.windowId;
            detached.heartbeat = Date.now();
            saveSessions(this.ctx);
            return;
        }

        const runtime: Runtime = {
            id: crypto.randomBytes(4).toString('hex'),
            host: '',
            cpus: '',
            memory: '',
            gpu: '',
            wallTime: '',
            queue: '',
            allocation: '',
            status: 'Local',
            submittedAt: new Date(),
            type: 'local',
            isLocal: true,
            windowId: this.ctx.windowId,
            heartbeat: Date.now(),
        };

        ws.runtimes.push(runtime);
        saveSessions(this.ctx);
    }

    /**
     * Update heartbeat timestamp for this window's session.
     */
    private _heartbeat() {
        this._pruneStaleWindows();
        for (const ws of this.ctx.workspaces) {
            const runtime = ws.runtimes.find(r => r.windowId === this.ctx.windowId);
            if (runtime) {
                runtime.heartbeat = Date.now();
                saveSessions(this.ctx);
                return;
            }
        }
    }

    /**
     * Detach runtimes from closed windows (stale heartbeat) by clearing their windowId.
     * Does NOT remove runtimes or workspaces — workspace cards persist until explicitly removed.
     * Promoted sessions (slurmJobId or non-Local status) are never detached.
     */
    private _pruneStaleWindows() {
        const cutoff = Date.now() - 60_000;
        let pruned = false;
        for (const ws of this.ctx.workspaces) {
            for (const s of ws.runtimes) {
                // Mark stale Local runtimes as inactive (closed window)
                if (s.windowId && s.windowId !== this.ctx.windowId && s.status === 'Local' && !s.slurmJobId) {
                    if (!s.heartbeat || s.heartbeat <= cutoff) {
                        s.windowId = undefined; // Detach from closed window
                        pruned = true;
                    }
                }
            }
        }
        // Save only if something was actually pruned
        if (pruned) {
            saveSessions(this.ctx);
        }
    }

    public dispose() {
        this.ctx.disposing = true;
        // Stop timers
        if (this.ctx.heartbeatTimer) {
            clearInterval(this.ctx.heartbeatTimer);
            this.ctx.heartbeatTimer = undefined;
        }
        if (this.ctx.countdownTimer) {
            clearInterval(this.ctx.countdownTimer);
            this.ctx.countdownTimer = undefined;
        }
        this.ctx.statusBarItem.dispose();
        this._stopSessionPolling();
        // Stop all local linkspan processes (clean shutdown)
        this.ctx.localLinkspan.stopAll();
        fs.unwatchFile(this.ctx.sessionsFilePath);
        // Full cleanup for all sessions
        for (const session of allRuntimes(this.ctx.workspaces)) {
            const sessionId = session.id;
            // Terminate VFS synchronously (no await in dispose)
            this.ctx.syncProvider.stopSync(session);
            this.ctx.mountProvider.stopSync(session);
            // Clear tunnel connection state
            session.connectionId = undefined;
            session._portMap = undefined;
            session.sshTunnelLocalPort = undefined;
            // Remove SSH config entry
            const alias = session.isLocal ? `cs-tunnel-${sessionId}` : `cs-session-${sessionId}`;
            this._removeSshConfigEntry(sessionId, alias);
        }
        // Clean up window registration
        for (const ws of this.ctx.workspaces) {
            const myRuntime = ws.runtimes.find(r => r.windowId === this.ctx.windowId);
            if (myRuntime) {
                if (myRuntime.status === 'Local') {
                    ws.runtimes = ws.runtimes.filter(r => r.id !== myRuntime.id);
                } else {
                    myRuntime.windowId = undefined;
                }
                break;
            }
        }
        this.ctx.workspaces = this.ctx.workspaces.filter(ws => ws.runtimes.length > 0);
        // Dispose association cancellation tokens
        for (const [, cts] of this.ctx.associationsCts) {
            cts.cancel();
            cts.dispose();
        }
        this.ctx.associationsCts.clear();
        // Save cleaned state
        saveSessions(this.ctx);
        // Final process cleanup
        this.ctx.ssh.disposePersistentShells();
        this.stopAllLogStreams();
        this.stopAllLocalProcesses();
    }

    /**
     * Whether a session still needs setup polling.
     * True when the session is non-terminal and hasn't completed tunnel setup.
     */
    private _sessionNeedsSetupPolling(s: Runtime): boolean {
        if (!s.slurmJobId || s.isLocal) { return false; }
        if (s.status === 'Failed' || s.status === 'Completed') { return false; }
        // Still needs polling if tunnel isn't fully connected
        if (!s.tunnelUrl || !s._portMap || !s.connectionId) { return true; }
        return false;
    }

    /**
     * Start auto-polling for session setup. Polls every 5 seconds only while
     * sessions are still setting up (waiting for SLURM allocation, workflow
     * variables, or tunnel connection). Stops automatically once all sessions
     * are either terminal or fully connected.
     */
    private _startSessionPolling() {
        if (this.ctx.sessionPollTimer) {
            return; // already polling
        }
        this.ctx.outputChannel.appendLine('[poll] Starting session setup poll (every 5s)');

        const doPoll = async () => {
            if (this.ctx.sessionPollBusy) { return; }
            this.ctx.sessionPollBusy = true;
            try {
                await this.refreshSessions();
            } finally {
                this.ctx.sessionPollBusy = false;
            }
            // Stop polling if no sessions need setup monitoring
            if (!allRuntimes(this.ctx.workspaces).some(s => this._sessionNeedsSetupPolling(s))) {
                this._stopSessionPolling();
            }
        };

        // Fire immediately, then every 5 seconds
        doPoll();
        this.ctx.sessionPollTimer = setInterval(doPoll, 5000);
    }

    private _stopSessionPolling() {
        if (this.ctx.sessionPollTimer) {
            this.ctx.outputChannel.appendLine('[poll] Stopping session auto-poll');
            clearInterval(this.ctx.sessionPollTimer);
            this.ctx.sessionPollTimer = undefined;
        }
    }

    /**
     * Dispose all persistent SSH shells.
     */
    public disposePersistentShells() {
        for (const [, shell] of this.ctx.persistentShells) {
            shell.process.kill();
        }
        this.ctx.persistentShells.clear();
    }

    // TODO: Move to ssh manager
    /**
     * Execute a command on a remote host via SSH using spawnSync with proper
     * argument arrays. This avoids all shell quoting issues — the command
     * string is passed as a single SSH argument so the remote shell interprets
     * it directly, with no intermediate local shell expansion.
     */
    private _sshExec(
        host: string,
        command: string,
        opts?: { timeout?: number; input?: string },
    ): { stdout: string; ok: boolean } {
        const args = [
            '-o', 'ConnectTimeout=5',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            ...this.ctx.ssh.getControlMasterArgs(host),
            host,
            command,
        ];
        const result = spawnSync('ssh', args, {
            encoding: 'utf-8',
            timeout: opts?.timeout ?? 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
            input: opts?.input,
        });
        return {
            stdout: (result.stdout || '').trim(),
            ok: result.status === 0,
        };
    }

    /**
     * Resolve an SSH config alias to its actual HostName.
     * Returns the HostName if found, otherwise returns the alias as-is.
     */
    private _resolveHostname(alias: string): string {
        const hosts = getSshHosts();
        const match = hosts.find(h => h.name === alias);
        return match?.hostname ?? alias;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        const viewType = webviewView.viewType;
        const isSessions = viewType === CybershuttleViewProvider.sessionsViewType;

        if (isSessions) {
            this._sessionsView = webviewView;
        } else {
            this._storagesView = webviewView;
        }

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        try {
            if (isSessions) {
                webviewView.webview.html = getSessionsHtml(webviewView.webview, this._extensionUri, this.ctx.workspaces, this.ctx.windowId);
            } else {
                webviewView.webview.html = getStoragesHtml(webviewView.webview, this._extensionUri, this.ctx.storageBrowser);
            }
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[webview] Failed to render: ${err.message}\n${err.stack}`);
            webviewView.webview.html = `<html><body><p>Failed to load CyberShuttle panel: ${err.message}</p></body></html>`;
        }

        // Check Dev Tunnels auth on startup from the sessions view
        if (isSessions) {
            webviewView.title = 'Sessions';
            this.ctx.tunnelManager.checkDevTunnelAuth();
        }

        webviewView.onDidDispose(() => {
            if (isSessions) {
                this._sessionsView = undefined;
                this.ctx.ssh.disposePersistentShells();
                this.stopAllLogStreams();
                this._stopSessionPolling();
            } else {
                this._storagesView = undefined;
            }
        });

        // Route messages from all views into the same handler
        webviewView.webview.onDidReceiveMessage((data) => this._onMessage(data));

        // Runtime updates are sent when the webview JS signals 'webviewReady'
    }

    /**
     * Handle Add Remote command — opens ~/.ssh/config so the user can add a new SSH host.
     */
    public async handleAddRemote() {
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        try {
            const doc = await vscode.workspace.openTextDocument(sshConfigPath);
            await vscode.window.showTextDocument(doc);
        } catch {
            vscode.window.showErrorMessage('Could not open ~/.ssh/config. Ensure the file exists.');
        }
    }

    /**
     * Handle Storages navigation commands from VS Code title bar buttons.
     */
    public handleStoragesNav(type: string) {
        this._onMessage({ type });
    }

    /**
     * Central message handler — receives messages from both the Sessions and Storages webviews.
     */
    private async _onMessage(data: any) {
        switch (data.type) {
            case 'webviewReady': {
                // Webview JS has loaded and registered its message listener —
                // send runtime data now so sessions move past "Loading..." state.
                this._sendRuntimeUpdates();
                break;
            }
            case 'switchToWindow': {
                this.switchToWindow(data.sessionId);
                break;
            }
            case 'storagesBrowseDir': {
                this.ctx.storageBrowser.navigateTo(data.host, data.path);
                this.refreshStorages();
                this.ctx.storageBrowser.browseCurrent();
                break;
            }
            case 'storagesOpenFile': {
                this.ctx.storageBrowser.openRemoteFile(data.host, data.path);
                break;
            }
            case 'storagesGoBack': {
                if (this.ctx.storageBrowser.goBack()) {
                    this.refreshStorages();
                    this.ctx.storageBrowser.browseCurrent();
                }
                break;
            }
            case 'storagesGoForward': {
                if (this.ctx.storageBrowser.goForward()) {
                    this.refreshStorages();
                    this.ctx.storageBrowser.browseCurrent();
                }
                break;
            }
            case 'storagesRefresh': {
                this.ctx.storageBrowser.browseCurrent();
                break;
            }
            case 'storagesGoHome': {
                this.ctx.storageBrowser.goHome();
                this.refreshStorages();
                break;
            }
            case 'addRuntime': {
                const { host, cpus, memory, gpu, wallTime, queue, allocation, workspaceId } = data;
                const sessionId = crypto.randomBytes(4).toString('hex');
                let ws = workspaceId ? this.ctx.workspaces.find(w => w.id === workspaceId) : undefined;
                if (!ws) {
                    const folder = vscode.workspace.workspaceFolders?.[0];
                    const dirPath = folder
                        ? (folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString())
                        : 'unknown';
                    ws = this._getOrCreateWorkspace(dirPath);
                }
                const newRuntime: Runtime = {
                    id: sessionId,
                    host,
                    cpus,
                    memory,
                    gpu,
                    wallTime,
                    queue,
                    allocation,
                    status: 'Idle',
                    submittedAt: new Date(),
                    type: 'remote',
                    noSlurm: !!data.noSlurm,
                    connectedRemotePath: this._filesystemSyncEnabled ? `~/overlay/${sessionId}` : undefined,
                };
                ws.runtimes.push(newRuntime);
                // Save last-used allocation/partition per host
                saveHostPrefs(this.ctx.workspaceState, host, { allocation, partition: queue });
                saveSessions(this.ctx);
                this.refreshSessionsView();
                break;
            }
            case 'queryAssociations': {
                queryAssociations(data.host, this.ctx.outputChannel, this.ctx.ssh, this._extensionUri,
                    this.ctx.cachedRemoteHome, this.ctx.associationsCts, this.ctx.workspaceState,
                    this._postSessionsMessage);
                break;
            }
            case 'relaunchSession': {
                this.relaunchSession(data.sessionId);
                break;
            }
            case 'closeSession': {
                const found = findRuntime(data.sessionId, this.ctx);
                if (found) {
                    const rt = found.runtime;
                    // If closing a local session, confirm and close all remotes in the workspace
                    if (rt.isLocal) {
                        const remotes = found.workspace.runtimes.filter(r => !r.isLocal);
                        if (remotes.length > 0) {
                            const answer = await vscode.window.showWarningMessage(
                                `This will close all ${remotes.length} remote session${remotes.length > 1 ? 's' : ''} and close the current window. Continue?`,
                                { modal: true },
                                'Yes'
                            );
                            if (answer !== 'Yes') { break; }
                        }
                        // Clean up all remote sessions first
                        for (const remote of remotes) {
                            if (remote.slurmJobId && remote.status !== 'Failed' && remote.status !== 'Completed') {
                                this.ctx.ssh.runRemoteCommand(remote.host, `scancel ${remote.slurmJobId}`).catch(() => { });
                            }
                            await this._cleanupSessionConnections(remote, remote.id);
                            this.ctx.ssh.killShell(remote.host);
                            const logTail = this.ctx.logTailProcesses.get(remote.id);
                            if (logTail) {
                                logTail.kill();
                                this.ctx.logTailProcesses.delete(remote.id);
                            }
                        }
                        // Stop and remove the local session + entire workspace
                        await this.stopLocalSession(data.sessionId);
                        this.ctx.workspaces = this.ctx.workspaces.filter(w => w.id !== found.workspace.id);
                    } else {
                        // Closing a remote session
                        if (rt.slurmJobId && rt.status !== 'Failed' && rt.status !== 'Completed') {
                            this.ctx.ssh.runRemoteCommand(rt.host, `scancel ${rt.slurmJobId}`).catch(() => { });
                        }
                        await this._cleanupSessionConnections(rt, rt.id);
                        this.ctx.ssh.killShell(rt.host);
                        const logTail = this.ctx.logTailProcesses.get(rt.id);
                        if (logTail) {
                            logTail.kill();
                            this.ctx.logTailProcesses.delete(rt.id);
                        }
                        found.workspace.runtimes = found.workspace.runtimes.filter(r => r.id !== data.sessionId);
                        if (found.workspace.runtimes.length === 0) {
                            this.ctx.workspaces = this.ctx.workspaces.filter(w => w.id !== found.workspace.id);
                        }
                    }
                }
                saveSessions(this.ctx);
                this.refreshSessionsView();
                this.refreshStorages();
                break;
            }
            case 'confirmJob': {
                this.submitJob(data.sessionId);
                break;
            }
            case 'cancelJob': {
                this.cancelJobPreview(data.sessionId);
                break;
            }
            case 'testLocal': {
                this.testLocal();
                break;
            }
            case 'stopLocal': {
                await this.stopLocalSession(data.sessionId);
                break;
            }
            case 'connectLocal': {
                this.connectLocalSession(data.sessionId);
                break;
            }
            case 'viewLogs': {
                this.viewSessionLogs(data.sessionId);
                break;
            }
            case 'toggleSessionLogs': {
                this.toggleSessionLogStream(data.sessionId);
                break;
            }
            case 'stopSessionLogs': {
                this.stopSessionLogStream(data.sessionId);
                break;
            }
            case 'stopRemote': {
                this.stopRemoteSession(data.sessionId);
                break;
            }
            case 'sessionExpired': {
                await this._handleSessionExpired(data.sessionId);
                break;
            }
            case 'restartLinkspan': {
                this.restartLocalLinkspan(data.sessionId);
                break;
            }
            case 'startLinkspan': {
                this.startLocalLinkspan();
                break;
            }
            case 'stopLinkspan': {
                this.stopLocalLinkspan();
                break;
            }
            case 'copyToClipboard': {
                if (data.text) {
                    vscode.env.clipboard.writeText(data.text);
                }
                break;
            }
            case 'switchToRemote': {
                this.switchToRemote(data.sessionId);
                break;
            }
            case 'switchToLocal': {
                this.switchToLocal(data.sessionId);
                break;
            }
        }
    }


    /**
     * Send current auth state to the sessions webview and update the view title.
     */
    public postAuthState(account?: string | null) {
        const acct = account ?? this.ctx.tunnelManager.devTunnelAccount;
        // Update sessions view title with account
        if (this._sessionsView) {
            this._sessionsView.title = acct
                ? `Sessions (${acct})`
                : 'Sessions';
            this._sessionsView.description = undefined;
        }
    }

    /**
     * Generate a SLURM batch script from job parameters.
     * The script embeds a workflow YAML and pipes it to linkspan via stdin heredoc.
     * Assumes linkspan is available in PATH.
     */
    public generateSlurmScript(params: {
        cpus: string;
        memory: string;
        gpu: string;
        wallTime: string;
        queue: string;
        allocation: string;
        authToken: string;
        provider: string;
        serverUrl?: string;
        host?: string;
        sessionId?: string;
        localTunnelId?: string;
        localTunnelToken?: string;
        localSshPort?: number;
        localWorkspace?: string;
        filesystemSync?: boolean;
    }): string {
        const { cpus, memory, gpu, wallTime, queue, allocation, authToken, sessionId } = params;

        // Parse memory value (e.g. "8 GB" → "8G")
        const memSlurm = memory.replace(/\s+/g, '');

        // Build #SBATCH lines.
        const sbatchLines = [
            `#SBATCH --job-name=linkspan-session`,
            `#SBATCH --ntasks=1`,
            `#SBATCH --cpus-per-task=${cpus}`,
            `#SBATCH --mem=${memSlurm}`,
            `#SBATCH --time=${wallTime}`,
            `#SBATCH --partition=${queue}`,
            `#SBATCH --account=${allocation}`,
        ];

        // Add GPU if selected (format: "type:count" or "count")
        if (gpu !== 'None') {
            sbatchLines.push(`#SBATCH --gres=gpu:${gpu}`);
        }

        // Build the workflow YAML that will be passed to linkspan via stdin.
        const hostSlug = (params.host || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-');
        const fsSync = params.filesystemSync !== false;
        const workflowYaml = generateLinkspanWorkflow(`ls-${hostSlug}-${sessionId || 'unknown'}`, params.provider, params.serverUrl, fsSync);

        const scriptLines = [
            `#!/bin/bash`,
            ...sbatchLines,
            ``,
            `# --- Set up log files using $HOME ---`,
            `LOG_DIR="$HOME/.cybershuttle/logs"`,
            `mkdir -p "$LOG_DIR"`,
            `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
            ``,
        ];

        if (fsSync) {
            scriptLines.push(
                `# --- Local linkspan overlay variables ---`,
                `export CS_LOCAL_TUNNEL_ID='${params.localTunnelId || ''}'`,
                `export CS_LOCAL_TUNNEL_TOKEN='${params.localTunnelToken || ''}'`,
                `export CS_LOCAL_SSH_PORT='${params.localSshPort || 0}'`,
                `export CS_LOCAL_WORKSPACE='${params.localWorkspace || ''}'`,
                `export CS_SESSION_ID='${sessionId || ''}'`,
                ``,
            );
        }

        scriptLines.push(
            `# --- Run linkspan (pre-deployed via scp) ---`,
            `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
            `"$LINKSPAN_BIN" --port 0 --tunnel-auth-token '${authToken}' --workflow - <<WORKFLOW_EOF`,
            workflowYaml,
            `WORKFLOW_EOF`,
        );

        const script = scriptLines.join('\n');

        return script;
    }

    /**
     * Generate a plain bash script (no SLURM directives) for non-SLURM hosts.
     */
    public generatePlainScript(params: {
        authToken: string;
        provider: string;
        serverUrl?: string;
        host?: string;
        sessionId?: string;
        localTunnelId?: string;
        localTunnelToken?: string;
        localSshPort?: number;
        localWorkspace?: string;
        filesystemSync?: boolean;
    }): string {
        const { authToken, sessionId } = params;
        const fsSync = params.filesystemSync !== false;
        const hostSlug = (params.host || 'plain').replace(/[^a-zA-Z0-9-]/g, '-');
        const workflowYaml = generateLinkspanWorkflow(`ls-${hostSlug}-${sessionId || 'unknown'}`, params.provider, params.serverUrl, fsSync);

        const scriptLines = [
            `#!/bin/bash`,
            ``,
            `# --- Set up log files using $HOME ---`,
            `LOG_DIR="$HOME/.cybershuttle/logs"`,
            `mkdir -p "$LOG_DIR"`,
            `exec > "$LOG_DIR/linkspan-session-${sessionId || '$$'}.out" 2> "$LOG_DIR/linkspan-session-${sessionId || '$$'}.err"`,
            ``,
        ];

        if (fsSync) {
            scriptLines.push(
                `# --- Local linkspan overlay variables ---`,
                `export CS_LOCAL_TUNNEL_ID='${params.localTunnelId || ''}'`,
                `export CS_LOCAL_TUNNEL_TOKEN='${params.localTunnelToken || ''}'`,
                `export CS_LOCAL_SSH_PORT='${params.localSshPort || 0}'`,
                `export CS_LOCAL_WORKSPACE='${params.localWorkspace || ''}'`,
                `export CS_SESSION_ID='${sessionId || ''}'`,
                ``,
            );
        }

        scriptLines.push(
            `# --- Run linkspan (pre-deployed via scp) ---`,
            `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
            `"$LINKSPAN_BIN" --port 0 --tunnel-auth-token '${authToken}' --workflow - <<WORKFLOW_EOF`,
            workflowYaml,
            `WORKFLOW_EOF`,
        );

        const script = scriptLines.join('\n');

        return script;
    }

    /**
     * Submit a previously previewed SLURM job via sbatch over SSH.
     */
    private async submitJob(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session || !session.script) {
            vscode.window.showErrorMessage('Session not found or script missing.');
            return;
        }

        session.status = 'Submitting';
        saveSessions(this.ctx);
        this._sendRuntimeUpdates();
        this._updateStatusBar();

        const submitStart = Date.now();
        this.ctx.metrics.record('job_submit', 'in_progress', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Submitting job on ${session.host}`,
            cancellable: true,
        }, async (progress, token) => {
            this.ctx.outputChannel.appendLine(`\n--- Submitting SLURM job on ${session.host} ---`);

            try {
                // Set up local workspace info (only when filesystem sync is enabled)
                if (this._filesystemSyncEnabled && !this.isRemoteWindow && vscode.workspace.workspaceFolders?.[0]) {
                    const localWorkdir = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    session.localWorkdir = localWorkdir;
                    session.connectedRemotePath = `~/overlay/${session.id}`;
                    saveSessions(this.ctx);
                    // Require local linkspan to be running (user starts it via UI/command)
                    const localInfo = this.ctx.localLinkspan.get(localWorkdir);
                    if (!localInfo?.tunnelId) {
                        throw new Error('Local linkspan is not running. Start it first via the Sessions panel or "CyberShuttle: Start Linkspan" command.');
                    }

                    // Pre-delete any stale remote tunnel so linkspan creates a fresh one
                    const hostSlug = (session.host || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-');
                    const remoteTunnelName = `ls-${hostSlug}-${session.id}`;
                    this._deleteDevTunnel(remoteTunnelName);

                    const creds = await this.ctx.tunnelManager.getCredentials();
                    const localParams = {
                        localTunnelId: localInfo.tunnelId,
                        localTunnelToken: localInfo.tunnelToken,
                        localSshPort: localInfo.sshPort,
                        localWorkspace: localWorkdir,
                    };
                    if (session.noSlurm) {
                        session.script = this.generatePlainScript({ authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, host: session.host, sessionId: session.id, ...localParams });
                    } else {
                        session.script = this.generateSlurmScript({
                            cpus: session.cpus, memory: session.memory, gpu: session.gpu,
                            wallTime: session.wallTime, queue: session.queue, allocation: session.allocation,
                            authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, ...localParams,
                        });
                    }
                }

                // Deploy linkspan binary to the remote host
                session.status = 'Deploying agent';
                this._sendRuntimeUpdates();
                progress.report({ message: 'Deploying linkspan binary...' });
                await this.deployLinkspan(session.host, token);
                session.status = 'Submitting';
                this._sendRuntimeUpdates();
                progress.report({ message: session.noSlurm ? 'Starting remote session...' : 'Sending batch script...' });
                const scriptB64 = Buffer.from(session.script!).toString('base64');
                const submitCmd = session.noSlurm
                    ? `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d > /tmp/cs-plain-$$.sh && chmod +x /tmp/cs-plain-$$.sh && nohup /tmp/cs-plain-$$.sh </dev/null &>/dev/null & echo "PID:$!"`
                    : `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d | sbatch`;
                const result = await this.ctx.ssh.runRemoteCommand(session.host, submitCmd, token);

                if (result.code === 0) {
                    if (session.noSlurm) {
                        const pidMatch = result.stdout.match(/PID:(\d+)/);
                        session.slurmJobId = pidMatch ? `pid-${pidMatch[1]}` : undefined;
                        session.status = 'Active';
                        session.errorMessage = undefined;
                        this.ctx.outputChannel.appendLine(result.stdout);
                        progress.report({ message: 'Session started — waiting for tunnel...' });
                        this._startSessionPolling();
                    } else {
                        const match = result.stdout.match(/Submitted batch job (\d+)/);
                        session.slurmJobId = match ? match[1] : undefined;
                        session.status = 'Pending';
                        session.errorMessage = undefined;
                        this.ctx.outputChannel.appendLine(result.stdout);
                        progress.report({ message: `Job ${session.slurmJobId || ''} submitted — waiting for node allocation...` });
                        this._startSessionPolling();
                    }
                    this.ctx.metrics.record('job_submit', 'success', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime, job_id_slurm: session.slurmJobId }, Date.now() - submitStart);
                } else {
                    session.status = 'Failed';
                    const errLines = (result.stderr || '').split('\n')
                        .map((l: string) => l.replace(/^sbatch:\s*error:\s*/i, '').trim())
                        .filter((l: string) => l.length > 0);
                    session.errorMessage = errLines.join(' ') || `exit code ${result.code}`;
                    this.ctx.outputChannel.appendLine(`Submit exited with code ${result.code}`);
                    if (result.stderr) {
                        this.ctx.outputChannel.appendLine(result.stderr);
                    }
                    vscode.window.showErrorMessage(`Failed to start session on ${session.host}: ${session.errorMessage}`);
                    this.ctx.metrics.record('job_submit', 'failure', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime }, Date.now() - submitStart, session.errorMessage);
                }
            } catch (err: any) {
                if (err.cancelled) {
                    session.status = 'Failed';
                    session.errorMessage = 'Cancelled by user';
                    this.ctx.outputChannel.appendLine('Job submission cancelled by user');
                    vscode.window.showInformationMessage(`Job submission on ${session.host} cancelled.`);
                } else {
                    session.status = 'Failed';
                    session.errorMessage = err.message;
                    this.ctx.outputChannel.appendLine(`Error: ${err.message}`);
                    vscode.window.showErrorMessage(`Failed to submit job: ${err.message}`);
                }
                this.ctx.metrics.record('job_submit', 'failure', { cluster: session.host }, Date.now() - submitStart, session.errorMessage);
            }

            // If submission failed, stop VFS providers (no point keeping them running)
            if (session.status === 'Failed') {
                await this.ctx.syncProvider.stop(session);
                await this.ctx.mountProvider.stop(session);
            }

            saveSessions(this.ctx);
            this._sendRuntimeUpdates();
            this._updateStatusBar();
        });
    }

    /**
     * Deploy the linkspan binary to a remote host by downloading the latest
     * release from GitHub (https://github.com/cyber-shuttle/linkspan).
     */
    private async deployLinkspan(hostName: string, token?: vscode.CancellationToken): Promise<void> {
        const deployStart = Date.now();
        this.ctx.metrics.record('linkspan_deploy', 'in_progress', { deploy_type: 'remote', target_host: hostName });
        try {
            // Detect remote architecture
            const archResult = await this.ctx.ssh.runRemoteCommand(hostName, 'uname -m', token);
            if (archResult.code !== 0) {
                throw new Error('Failed to detect remote architecture');
            }
            let arch = archResult.stdout.trim();
            if (arch === 'aarch64') { arch = 'arm64'; }

            const assetName = `linkspan_Linux_${arch}.tar.gz`;
            const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;

            // Check if remote binary is already at the latest version
            const versionCheck = await this.ctx.ssh.runRemoteCommand(hostName, [
                `LOCAL_VER=$(~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo "")`,
                `REMOTE_VER=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | grep -oP '[^/]+$' || echo "")`,
                `echo "LOCAL=$LOCAL_VER REMOTE=$REMOTE_VER"`,
                `if [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ] && echo "$LOCAL_VER" | grep -q "$REMOTE_VER"; then echo "UP_TO_DATE"; fi`,
            ].join(' && '), token);

            if (versionCheck.code === 0 && versionCheck.stdout.includes('UP_TO_DATE')) {
                const verLine = versionCheck.stdout.split('\n')[0];
                this.ctx.outputChannel.appendLine(`linkspan on ${hostName} is up to date (${verLine})`);
                this.ctx.metrics.record('linkspan_deploy', 'success', { deploy_type: 'remote', target_host: hostName, skipped: 'up_to_date' }, Date.now() - deployStart);
                return;
            }

            // Download latest release from GitHub directly on the remote host
            this.ctx.outputChannel.appendLine(`Downloading linkspan to ${hostName} from ${downloadUrl}`);
            await this.ctx.ssh.runRemoteCommand(hostName, `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`, token);
            this.ctx.outputChannel.appendLine('linkspan deployed to ' + hostName);
            this.ctx.metrics.record('linkspan_deploy', 'success', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart);
        } catch (err: any) {
            this.ctx.metrics.record('linkspan_deploy', 'failure', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart, err.message);
            throw err;
        }
    }

    /**
     * Fetch session log files from the remote host and display in the output channel.
     */
    private async viewSessionLogs(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session || !session.slurmJobId) {
            vscode.window.showErrorMessage('Session not found or no SLURM job ID available.');
            return;
        }

        const jobId = session.slurmJobId;
        const logBase = `$HOME/.cybershuttle/logs/linkspan-session-${jobId}`;
        this.ctx.outputChannel.appendLine(`\n--- Fetching logs for Job ${jobId} on ${session.host} ---`);

        try {
            const cmd = [
                `echo '=== STDOUT ==='`,
                `if [ -f ${logBase}.out ]; then tail -c 65536 ${logBase}.out; else echo '[No stdout log found]'; fi`,
                `echo ''`,
                `echo '=== STDERR ==='`,
                `if [ -f ${logBase}.err ]; then tail -c 65536 ${logBase}.err; else echo '[No stderr log found]'; fi`,
            ].join(' && ');
            const result = await this.ctx.ssh.runRemoteCommand(session.host, cmd);
            if (result.code === 0) {
                this.ctx.outputChannel.appendLine(result.stdout);
            } else {
                this.ctx.outputChannel.appendLine(`Failed to fetch logs (exit code ${result.code})`);
                if (result.stderr) {
                    this.ctx.outputChannel.appendLine(result.stderr);
                }
            }
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`Error fetching logs: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to fetch logs: ${err.message}`);
        }
    }

    /**
     * Toggle real-time log streaming for a session.
     * Connects to the linkspan's log stream socket via the tunnel port map.
     * The linkspan exposes a TCP log stream on its log port; the tunnel connect
     * forwards it to a local port which we connect to with a net.Socket.
     */
    private toggleSessionLogStream(sessionId: string) {
        // If already streaming, stop it
        if (this.ctx.logTailProcesses.has(sessionId)) {
            this.stopSessionLogStream(sessionId);
            return;
        }

        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session || !session.logPort || !session._portMap) {
            this.ctx.outputChannel.appendLine(`[linkspan-${session?.host}] Cannot stream logs: no log port or tunnel not connected`);
            return;
        }

        const localLogPort = session._portMap.get(session.logPort);
        if (!localLogPort) {
            this.ctx.outputChannel.appendLine(`[linkspan-${session.host}] Log port ${session.logPort} not in tunnel port map`);
            return;
        }

        const logTag = `[linkspan-${session.host}]`;
        const sock = new net.Socket();
        sock.connect(localLogPort, '127.0.0.1', () => {
            this.ctx.outputChannel.appendLine(`${logTag} connected to log stream (port ${localLogPort})`);
        });

        sock.on('data', (data: Buffer) => {
            const text = data.toString();
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    this.ctx.outputChannel.appendLine(`${logTag} ${line}`);
                }
            }
            this._postSessionsMessage({
                type: 'sessionLogData',
                sessionId,
                text,
            });
        });

        sock.on('error', (err: Error) => {
            this.ctx.outputChannel.appendLine(`${logTag} log stream error: ${err.message}`);
        });

        sock.on('close', () => {
            this.ctx.outputChannel.appendLine(`${logTag} log stream disconnected`);
            this.ctx.logTailProcesses.delete(sessionId);
            this._postSessionsMessage({ type: 'sessionLogStopped', sessionId });
        });

        // Store socket wrapped in a ChildProcess-like shape for cleanup
        const fakeProc: any = { kill: () => sock.destroy(), pid: -1 };
        fakeProc._logSocket = sock;
        this.ctx.logTailProcesses.set(sessionId, fakeProc);
        this._postSessionsMessage({ type: 'sessionLogStarted', sessionId });
    }

    private stopSessionLogStream(sessionId: string) {
        const proc = this.ctx.logTailProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this.ctx.logTailProcesses.delete(sessionId);
        }
        this._postSessionsMessage({ type: 'sessionLogStopped', sessionId });
    }

    private stopAllLogStreams() {
        for (const [, proc] of this.ctx.logTailProcesses) {
            proc.kill();
        }
        this.ctx.logTailProcesses.clear();
    }

    private stopAllLocalProcesses() {
        for (const [, proc] of this.ctx.localProcesses) {
            proc.kill();
        }
        this.ctx.localProcesses.clear();
    }

    private async relaunchSession(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }

        // Generate script on demand if missing
        if (!session.script) {
            let creds: TunnelCredentials;
            try {
                creds = await this.ctx.tunnelManager.getCredentials();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
                return;
            }
            const localInfo = session.localWorkdir ? this.ctx.localLinkspan.get(session.localWorkdir) : undefined;
            const localParams = {
                localTunnelId: localInfo?.tunnelId,
                localTunnelToken: localInfo?.tunnelToken,
                localSshPort: localInfo?.sshPort,
                localWorkspace: session.localWorkdir,
            };
            if (session.noSlurm) {
                session.script = this.generatePlainScript({ authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, host: session.host, sessionId: session.id, filesystemSync: this._filesystemSyncEnabled, ...localParams });
            } else {
                session.script = this.generateSlurmScript({
                    cpus: session.cpus, memory: session.memory, gpu: session.gpu,
                    wallTime: session.wallTime, queue: session.queue, allocation: session.allocation,
                    authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, filesystemSync: this._filesystemSyncEnabled, ...localParams,
                });
            }
        }

        // Clear all ephemeral state from the previous run
        session.slurmJobId = undefined;
        session.errorMessage = undefined;
        session.tunnelUrl = undefined;
        session.tunnelToken = undefined;
        session.tunnelId = undefined;
        session.sshPort = undefined;
        session.logPort = undefined;
        session.submittedAt = new Date();
        session.status = 'Pending';
        saveSessions(this.ctx);

        // Show preview and let user confirm
        this._postSessionsMessage({ type: 'scriptPreview', sessionId: session.id, host: session.host, script: session.script });
    }

    /**
     * Cancel a pending job preview — revert the session to Idle so the card stays.
     */
    private cancelJobPreview(sessionId: string) {
        const found = findRuntime(sessionId, this.ctx);
        if (found) {
            found.runtime.status = 'Idle';
            found.runtime.script = undefined;
        }
        saveSessions(this.ctx);
        this._postSessionsMessage({ type: 'scriptPreviewDismissed' });
        this.refreshSessionsView();
    }

    /**
     * Run linkspan locally for testing the workflow without SSH/SLURM.
     * Spawns linkspan as a child process with the workflow YAML via stdin.
     */
    private async testLocal() {
        const sessionId = crypto.randomBytes(4).toString('hex');

        // Get tunnel credentials before building the workflow
        let creds: TunnelCredentials;
        try {
            creds = await this.ctx.tunnelManager.getCredentials();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
            return;
        }

        const tunnelName = `ls-local-${sessionId}`;
        const localWorkdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const workflowYaml = generateLinkspanWorkflow(tunnelName, creds.provider, creds.serverUrl);

        const folder = vscode.workspace.workspaceFolders?.[0];
        const dirPath = folder
            ? (folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString())
            : localWorkdir;
        const ws = this._getOrCreateWorkspace(dirPath);

        const session: Runtime = {
            id: sessionId,
            host: 'local',
            cpus: '-',
            memory: '-',
            gpu: 'None',
            wallTime: '-',
            queue: '-',
            allocation: '-',
            status: 'Submitting',
            submittedAt: new Date(),
            type: 'local',
            script: workflowYaml,
            isLocal: true,
            localWorkdir: localWorkdir,
            connectedRemotePath: `${os.homedir()}/sessions/${sessionId}`,
        };

        ws.runtimes.push(session);
        saveSessions(this.ctx);
        this.refresh();

        this.ctx.outputChannel.appendLine(`\n--- Starting local linkspan session ---`);

        try {
            await launchLinkspanProcess(session, creds.authToken, this.ctx, this.refresh.bind(this));
            vscode.window.showInformationMessage('Local linkspan session started');
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = err.message;
            saveSessions(this.ctx);
            this.refresh();
            vscode.window.showErrorMessage(`Failed to start linkspan: ${err.message}`);
        }
    }

    /**
     * Connect to a remote session's tunnel via the local linkspan REST API.
     * Returns the port map (remotePort → localPort) or undefined on failure.
     */
    private async _connectViaTunnel(sessionId: string, session: Runtime): Promise<Map<number, number> | undefined> {
        if (!session.tunnelId || !session.tunnelToken) {
            this.ctx.outputChannel.appendLine('[tunnel] Missing tunnelId or tunnelToken');
            return undefined;
        }

        // Already connected — return cached port map
        if (session.connectionId && session._portMap) {
            return session._portMap;
        }

        // Use existing local linkspan — do NOT auto-start it
        const workspacePath = session.localWorkdir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localInfo = workspacePath ? this.ctx.localLinkspan.get(workspacePath) : undefined;

        if (!localInfo) {
            this.ctx.outputChannel.appendLine('[tunnel] Local linkspan not running, cannot connect. Start it first.');
            return undefined;
        }

        const provider = this.ctx.tunnelManager.getProvider();
        const baseUrl = `http://127.0.0.1:${localInfo.serverPort}`;
        this.ctx.outputChannel.appendLine(`[tunnel] Connecting to tunnel ${session.tunnelId} via linkspan REST (provider=${provider}, port=${localInfo.serverPort}, pid=${localInfo.pid})`);

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60_000);
            const resp = await fetch(`${baseUrl}/api/v1/tunnels/connect`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider,
                    tunnelId: session.tunnelId,
                    token: session.tunnelToken,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!resp.ok) {
                const body = await resp.text();
                this.ctx.outputChannel.appendLine(`[tunnel] Connect failed (${resp.status}): ${body}`);
                return undefined;
            }

            const result: any = await resp.json();
            session.connectionId = result.connectionId;
            const portMap = new Map<number, number>();
            for (const [remoteStr, localPort] of Object.entries(result.portMap)) {
                const remotePort = parseInt(remoteStr, 10);
                portMap.set(remotePort, localPort as number);
                this.ctx.outputChannel.appendLine(`[tunnel] Port mapped: remote ${remotePort} → local ${localPort}`);
            }
            session._portMap = portMap;
            saveSessions(this.ctx);
            this.ctx.outputChannel.appendLine(`[tunnel] Connected (connectionId=${result.connectionId})`);
            return portMap;
        } catch (err: any) {
            const cause = err.cause ? ` (cause: ${err.cause?.message || err.cause?.code || err.cause})` : '';
            this.ctx.outputChannel.appendLine(`[tunnel] Connect failed: ${err.message}${cause}`);
            return undefined;
        }
    }

    /**
     * Disconnect a tunnel connection via the local linkspan REST API.
     */
    private async _disconnectTunnel(session: Runtime): Promise<void> {
        if (!session.connectionId) {
            return;
        }

        const workspacePath = session.localWorkdir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localInfo = workspacePath ? this.ctx.localLinkspan.get(workspacePath) : undefined;
        if (!localInfo) {
            session.connectionId = undefined;
            session._portMap = undefined;
            return;
        }

        const baseUrl = `http://127.0.0.1:${localInfo.serverPort}`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            await fetch(`${baseUrl}/api/v1/tunnels/connect/${session.connectionId}`, {
                method: 'DELETE',
                signal: controller.signal,
            });
            clearTimeout(timeout);
            this.ctx.outputChannel.appendLine(`[tunnel] Disconnected (connectionId=${session.connectionId})`);
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[tunnel] Disconnect failed: ${err.message}`);
        }

        session.connectionId = undefined;
        session._portMap = undefined;
    }

    /**
     * Full teardown for a terminal session: sync-back, cleanup connections,
     * delete tunnel, clear session fields. Caller sets session.status first.
     */
    private async _teardownSession(session: Runtime, sessionId: string, logTag: string): Promise<void> {
        if (this.ctx.tearingDown.has(sessionId)) {
            this.ctx.outputChannel.appendLine(`[${logTag}] Teardown already in progress for ${sessionId}, skipping`);
            return;
        }
        this.ctx.tearingDown.add(sessionId);
        try {
            // 0. Stop continuous sync (flush + terminate mutagen)
            if ((session as any).mutagenSessionName) {
                try {
                    await this.ctx.dataCache.stopContinuousSync(session.id);
                    (session as any).mutagenSessionName = undefined;
                } catch (err: any) {
                    this.ctx.outputChannel.appendLine(`[${logTag}] Failed to stop continuous sync: ${err.message}`);
                }
            }

            // 1. Sync back FIRST (while connection is alive)
            if (session.localWorkdir && session.status !== 'Failed') {
                try {
                    session.syncProgress = { transferred: 0, total: 0 };
                    this.ctx.dataCache.onProgress = (transferred: number, total: number) => {
                        session.syncProgress = { transferred, total };
                        this.refreshSessionsView();
                    };
                    await this.ctx.dataCache.unstage(session.localWorkdir, session.host, session.id, (h: string, cmd: string) => this.ctx.ssh.runRemoteCommand(h, cmd));
                    session.syncProgress = undefined;
                    this.ctx.dataCache.onProgress = undefined;
                    this.refreshSessionsView();
                } catch (err: any) {
                    session.syncProgress = undefined;
                    this.ctx.dataCache.onProgress = undefined;
                    this.ctx.outputChannel.appendLine(`[${logTag}] Warning: Sync-back failed: ${err.message}`);
                }
            }

            // 2. Clean up connections (VFS, tunnel, SSH config)
            await this._cleanupSessionConnections(session, sessionId);

            // 3. Delete main session tunnel
            await this._deleteTunnel(session);

            // 4. Clear Tier 2 + Tier 3 fields and credentials
            clearSessionFields(session);
        } finally {
            this.ctx.tearingDown.delete(sessionId);
        }
    }

    /**
     * Clean up session connections: mutagen sync, tunnel, SSH config.
     */
    private async _cleanupSessionConnections(session: Runtime, sessionId: string): Promise<void> {
        // 1. Stop VFS provider (mutagen sync or sshfs mount)
        await this.ctx.syncProvider.stop(session);
        await this.ctx.mountProvider.stop(session);

        // 2. Disconnect tunnel via linkspan REST API
        await this._disconnectTunnel(session);
        session.sshTunnelLocalPort = undefined;

        // 3. Remove SSH config entry
        const alias = session.isLocal ? `cs-tunnel-${sessionId}` : `cs-session-${sessionId}`;
        this._removeSshConfigEntry(sessionId, alias);
    }

    /**
     * Delete a session's tunnel (the one created by linkspan on the remote).
     * Uses linkspan REST API if available, falls back to devtunnel CLI.
     */
    private async _deleteTunnel(session: Runtime): Promise<void> {
        if (!session.tunnelId && !session.slurmJobId) {
            return;
        }

        const provider = this.ctx.tunnelManager.getProvider();

        // Try linkspan REST API first
        const workspacePath = session.localWorkdir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localInfo = workspacePath ? this.ctx.localLinkspan.get(workspacePath) : undefined;
        if (localInfo && session.tunnelId) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10_000);
                await fetch(`http://127.0.0.1:${localInfo.serverPort}/api/v1/tunnels/${session.tunnelId}?provider=${provider}`, {
                    method: 'DELETE',
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                this.ctx.outputChannel.appendLine(`[tunnel] Deleted tunnel ${session.tunnelId} via linkspan REST`);
                return;
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[tunnel] REST delete failed, trying CLI fallback: ${err.message}`);
            }
        }

        // Fallback: devtunnel CLI (only works for devtunnel provider)
        if (provider === 'devtunnel') {
            const dtBin = this.ctx.tunnelManager.resolveDevTunnelBin();
            if (!dtBin) { return; }
            const hostSlug = (session.host || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-');
            const tunnelName = session.isLocal
                ? `ls-local-${session.id}`
                : `ls-${hostSlug}-${session.id}`;
            try {
                await new Promise<void>((resolve) => {
                    const proc = spawn(dtBin, ['delete', tunnelName, '-f'], {
                        stdio: 'ignore',
                        timeout: 10_000,
                    });
                    proc.on('close', () => resolve());
                    proc.on('error', () => resolve());
                });
            } catch { /* already gone */ }
        }
    }

    /**
     * Start a background linkspan process serving the local workdir over FUSE
     * with a devtunnel, so a remote session can mount it.
     * @deprecated Use local linkspan with tunnel.connect instead
     */
    private async startLocalFuseServer(session: Runtime, authToken: string): Promise<void> {
        if (!this._filesystemSyncEnabled) {
            this.ctx.outputChannel.appendLine('[fuse-server] Filesystem sync disabled, skipping local FUSE server');
            return;
        }
        const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workdir) {
            this.ctx.outputChannel.appendLine('[fuse-server] No workspace folder open, skipping local FUSE server');
            return;
        }

        session.localWorkdir = workdir;

        const linkspanPath = await ensureLocalLinkspan(this.ctx);
        const tunnelName = `ls-fuse-${session.id}`;

        const workflowYaml = [
            `name: "cs-bridge-fuse-server"`,
            ``,
            `steps:`,
            `  - action: "fuse.start_server"`,
            `    name: "Start FUSE server"`,
            `    params:`,
            `      root: "${workdir.replace(/"/g, '\\"')}"`,
            `    outputs:`,
            `      fuse_port: "fuse_server_port"`,
            ``,
            `  - action: "tunnel.devtunnel_create"`,
            `    name: "Create FUSE devtunnel"`,
            `    params:`,
            `      tunnel_name: "${tunnelName}"`,
            `      expiration: "1d"`,
            `      auth_token: "{{.TunnelAuthToken}}"`,
            `      ports:`,
            `        - "{{.fuse_server_port}}"`,
            `    outputs:`,
            `      tunnel_id: "fuse_tunnel_id"`,
            ``,
            `  - action: "tunnel.devtunnel_host"`,
            `    name: "Host FUSE devtunnel"`,
            `    params:`,
            `      tunnel_name: "${tunnelName}"`,
            `      auth_token: "{{.TunnelAuthToken}}"`,
            `    outputs:`,
            `      token: "fuse_connect_token"`,
        ].join('\n');

        const proc = spawn(linkspanPath, ['--port', '0', '--tunnel-auth-token', authToken, '--workflow', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        session.localFuseServerPid = proc.pid;

        proc.stdin!.write(workflowYaml);
        proc.stdin!.end();

        return new Promise<void>((resolve, reject) => {
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Timed out waiting for FUSE server + devtunnel'));
                }
            }, 120_000);

            const parseOutput = (text: string) => {
                for (const line of text.split('\n')) {
                    const cap = line.match(/workflow: captured (\S+) = (.+)/);
                    if (cap) {
                        const [, varName, value] = cap;
                        if (varName === 'fuse_server_port') {
                            session.localFusePort = parseInt(value, 10);
                        } else if (varName === 'fuse_tunnel_id') {
                            session.localFuseTunnelId = value.trim();
                        } else if (varName === 'fuse_connect_token') {
                            session.localFuseConnectToken = value.trim();
                        }
                        saveSessions(this.ctx);
                        this.refresh();
                    }

                    // Check if all FUSE info is captured
                    if (session.localFusePort && session.localFuseTunnelId && session.localFuseConnectToken && !resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        this.ctx.outputChannel.appendLine(
                            `[fuse-server] Local FUSE server ready: port=${session.localFusePort} tunnel=${session.localFuseTunnelId}`
                        );
                        resolve();
                    }

                    // Detect workflow errors
                    const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): (.+)/);
                    if (errMatch && !resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        reject(new Error(`FUSE server workflow failed: ${errMatch[1]}: ${errMatch[2].trim()}`));
                    }
                }
            };

            proc.stdout!.on('data', (data: Buffer) => {
                const text = data.toString();
                this.ctx.outputChannel.appendLine(`[fuse-server] ${text.trimEnd()}`);
                parseOutput(text);
            });

            proc.stderr!.on('data', (data: Buffer) => {
                const text = data.toString();
                this.ctx.outputChannel.appendLine(`[fuse-server] ${text.trimEnd()}`);
                parseOutput(text);
            });

            proc.on('close', (code) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`FUSE server process exited with code ${code}`));
                }
                session.localFuseServerPid = undefined;
                saveSessions(this.ctx);
            });

            proc.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    /**
     * Connect to a local linkspan session's SSH server.
     * For local tests, connects directly to localhost:<sshPort> since devtunnel
     * port forwarding would loop back to itself on the same machine.
     * The full devtunnel workflow is still validated (tunnel created + hosted),
     * but the VS Code connection uses the direct SSH path.
     */
    private async connectLocalSession(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }

        if (!session.sshPort) {
            vscode.window.showErrorMessage('SSH server not ready yet — waiting for linkspan to finish setup.');
            return;
        }

        // Write an SSH config entry (remove any existing entry first)
        const hostAlias = `cs-tunnel-${sessionId}`;
        if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshPort, 'user')) {
            return;
        }

        // Use saved remote path or auto-detect from FUSE mount
        let remotePath = session.connectedRemotePath;
        if (!remotePath) {
            if (session.localWorkdir) {
                // Local workdir is mounted at ~/sessions/<session-id>/ on remote
                remotePath = `${os.homedir()}/sessions/${sessionId}`;
            } else {
                remotePath = await vscode.window.showInputBox({
                    title: `Connect to linkspan session (localhost:${session.sshPort})`,
                    prompt: 'Enter the remote folder path',
                    placeHolder: '/home/user',
                    value: os.homedir(),
                });
            }
        }

        if (remotePath) {
            // Save workspace context before switching
            session.localWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            session.connectedRemotePath = remotePath;
            saveSessions(this.ctx);

            vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.from({
                    scheme: 'vscode-remote',
                    authority: `ssh-remote+${hostAlias}`,
                    path: remotePath,
                }),
                true
            );
        }
    }

    /**
     * Ensure ~/.ssh/config includes our internal config file so that
     * VS Code Remote-SSH (and plain ssh) can resolve cs-session-* / cs-tunnel-* hosts.
     */
    private _ensureSshInclude(): void {
        const sshDir = path.join(os.homedir(), '.ssh');
        const sshConfigPath = path.join(sshDir, 'config');
        const includeLine = `Include ${this.ctx.internalSshConfigPath}`;

        try {
            if (!fs.existsSync(sshDir)) {
                fs.mkdirSync(sshDir, { mode: 0o700 });
            }
            if (!fs.existsSync(sshConfigPath)) {
                fs.writeFileSync(sshConfigPath, `${includeLine}\n`, { mode: 0o600 });
                return;
            }
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            if (!content.includes(includeLine)) {
                // Include must appear before any Host/Match blocks to take effect
                fs.writeFileSync(sshConfigPath, `${includeLine}\n${content}`);
            }
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[ssh] Failed to add Include to ~/.ssh/config: ${err.message}`);
        }
    }

    /**
     * One-time migration: move any cs-session-* / cs-tunnel-* entries from
     * ~/.ssh/config into the internal config and clean them from the user file.
     */
    private _migrateLegacySshEntries(): void {
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        try {
            if (!fs.existsSync(sshConfigPath)) { return; }
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            const re = /(?:\n|^)# CS-Bridge auto-generated for session [^\n]+\nHost cs-(?:session|tunnel)-[^\n]+\n(?:    [^\n]+\n)*/gm;
            const matches = content.match(re);
            if (!matches || matches.length === 0) { return; }
            // Append matched blocks to internal config
            const internalPath = this.ctx.internalSshConfigPath;
            const existing = fs.existsSync(internalPath) ? fs.readFileSync(internalPath, 'utf-8') : '';
            fs.writeFileSync(internalPath, existing + matches.join(''));
            // Remove from ~/.ssh/config
            const cleaned = content.replace(re, '');
            fs.writeFileSync(sshConfigPath, cleaned);
            this.ctx.outputChannel.appendLine(`[ssh] Migrated ${matches.length} CS-Bridge entries from ~/.ssh/config to internal config`);
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[ssh] Migration failed: ${err.message}`);
        }
    }

    /**
     * Remove any CS-Bridge SSH config entry for the given session/host alias.
     */
    private _removeSshConfigEntry(sessionId: string, hostAlias: string): void {
        const configPath = this.ctx.internalSshConfigPath;
        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const re = new RegExp(
                `(?:\\n|^)# CS-Bridge auto-generated for session ${sessionId}\\nHost ${hostAlias}\\n(?:    [^\\n]+\\n)*`,
                'gm'
            );
            const cleaned = content.replace(re, '');
            if (cleaned !== content) {
                fs.writeFileSync(configPath, cleaned);
            }
        } catch { /* ignore if file doesn't exist */ }
    }

    /**
     * Remove any existing CS-Bridge SSH config entry for the session and write a
     * fresh one. Returns true on success, false if the append failed (an error
     * message is shown to the user in that case).
     */
    private _writeSshConfigEntry(
        sessionId: string,
        hostAlias: string,
        hostname: string,
        port: number,
        user: string,
        extraLines?: string[],
    ): boolean {
        // Remove any existing entry for this session
        this._removeSshConfigEntry(sessionId, hostAlias);

        // Ensure ~/.ssh/config includes our internal config
        this._ensureSshInclude();

        const configPath = this.ctx.internalSshConfigPath;
        const lines = [
            ``,
            `# CS-Bridge auto-generated for session ${sessionId}`,
            `Host ${hostAlias}`,
            `    HostName ${hostname}`,
            `    Port ${port}`,
            `    User ${user}`,
            `    StrictHostKeyChecking no`,
            `    UserKnownHostsFile /dev/null`,
        ];
        if (extraLines) {
            for (const line of extraLines) {
                lines.push(`    ${line}`);
            }
        }
        const configBlock = lines.join('\n');

        try {
            fs.appendFileSync(configPath, configBlock + '\n');
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update SSH config: ${err.message}`);
            return false;
        }

        return true;
    }

    /**
     * @deprecated Old FUSE mount — kept for reference only, not called in new code.
     */
    private async launchFuseMount(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session || !session.remoteFusePort) {
            return;
        }

        let linkspanPath: string;
        try {
            linkspanPath = await ensureLocalLinkspan(this.ctx);
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[fuse-mount] Failed to get linkspan binary: ${err.message}`);
            return;
        }

        let fuseAddr: string;

        if (session.isLocal) {
            // Local session: FUSE server is on this machine
            fuseAddr = `127.0.0.1:${session.remoteFusePort}`;
        } else if (session.tunnelId && session.tunnelToken && session.remoteFusePort) {
            // Remote SLURM session: forward FUSE port via shared Dev Tunnel connect
            const portMap = await this._ensureDevTunnelConnected(sessionId, session);
            if (!portMap) {
                this.ctx.outputChannel.appendLine('[fuse-mount] Dev Tunnel not available, skipping mount');
                return;
            }

            const localFusePort = portMap.get(session.remoteFusePort);
            if (!localFusePort) {
                this.ctx.outputChannel.appendLine(`[fuse-mount] FUSE port ${session.remoteFusePort} was not forwarded by Dev Tunnel`);
                return;
            }
            fuseAddr = `127.0.0.1:${localFusePort}`;
        } else {
            this.ctx.outputChannel.appendLine('[fuse-mount] Missing compute node or host info, skipping FUSE mount');
            return;
        }

        this.ctx.outputChannel.appendLine(`\n--- Starting NFS mount for session ${sessionId} (${fuseAddr}) ---`);

        const proc = spawn(linkspanPath, [
            '--mount-remote',
            '--session-id', sessionId,
            '--server-addr', fuseAddr,
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        session.fuseMountPid = proc.pid;
        saveSessions(this.ctx);

        proc.stdout!.on('data', (data: Buffer) => {
            const text = data.toString();
            this.ctx.outputChannel.appendLine(`[fuse-mount] ${text.trimEnd()}`);

            for (const line of text.split('\n')) {
                const mountPath = line.match(/MOUNT_PATH=(.+)/);
                if (mountPath) {
                    session.localMountPath = mountPath[1].trim();
                    saveSessions(this.ctx);
                    this.refresh();
                }
            }
        });

        proc.stderr!.on('data', (data: Buffer) => {
            this.ctx.outputChannel.appendLine(`[fuse-mount/err] ${data.toString().trimEnd()}`);
        });

        proc.on('close', () => {
            const s = findRuntime(sessionId, this.ctx)?.runtime;
            if (s) {
                s.fuseMountPid = undefined;
                s.localMountPath = undefined;
                saveSessions(this.ctx);
                this.refresh();
            }
        });
    }

    /**
     * Find a free TCP port by binding to port 0 and reading the assigned port.
     */
    private findFreePort(): Promise<number | null> {
        return new Promise((resolve) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                const port = addr && typeof addr === 'object' ? addr.port : null;
                srv.close(() => resolve(port));
            });
            srv.on('error', () => resolve(null));
        });
    }

    /**
     * Wait for a TCP port on 127.0.0.1 to accept connections, retrying with
     * exponential backoff.  Returns true if the port became reachable within
     * the retry budget, false otherwise.
     */
    private async _waitForPort(port: number, maxRetries = 5, initialDelayMs = 2000): Promise<boolean> {
        let delay = initialDelayMs;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const reachable = await new Promise<boolean>((resolve) => {
                const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
                    sock.destroy();
                    resolve(true);
                });
                sock.setTimeout(3000);
                sock.on('timeout', () => { sock.destroy(); resolve(false); });
                sock.on('error', () => { sock.destroy(); resolve(false); });
            });
            if (reachable) {
                this.ctx.outputChannel.appendLine(`[tunnel] Port ${port} reachable (attempt ${attempt}/${maxRetries})`);
                return true;
            }
            this.ctx.outputChannel.appendLine(`[tunnel] Port ${port} not reachable, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 16000);
        }
        return false;
    }

    /**
     * Resolve the devtunnel CLI binary path.  Checks common locations since the
     * VS Code extension host PATH may not include /opt/homebrew/bin or ~/.linkspan/bin.
     */
    private _resolveDevTunnelBin(): string | undefined {
        const candidates = [
            path.join(os.homedir(), '.linkspan', 'bin', 'devtunnel'),
            '/opt/homebrew/bin/devtunnel',
            '/usr/local/bin/devtunnel',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) { return p; }
        }
        return undefined;
    }

    /**
     * Ensure the shared Dev Tunnel connect process is running for a remote session.
     * This forwards all tunnel ports (SSH + FUSE) from the compute node to localhost.
     * Waits for the connection to establish and parses port mappings from the CLI output.
     *
     * devtunnel connect output format:
     *   SSH: Forwarding from 127.0.0.1:<localPort> to host port <remotePort>.
     *
     * Returns a map of remotePort → localPort, or undefined on failure.
     */
    private async _ensureDevTunnelConnected(sessionId: string, session: Runtime): Promise<Map<number, number> | undefined> {
        if (!session.tunnelId || !session.tunnelToken) {
            this.ctx.outputChannel.appendLine('[devtunnel] Missing tunnelId or tunnelToken');
            return undefined;
        }

        // Already connected — return cached port map
        if (session.devtunnelConnectPid && session._devtunnelPortMap) {
            return session._devtunnelPortMap;
        }

        const devtunnelBin = this._resolveDevTunnelBin();
        if (!devtunnelBin) {
            this.ctx.outputChannel.appendLine('[devtunnel] ERROR: devtunnel binary not found');
            return undefined;
        }

        this.ctx.outputChannel.appendLine(
            `[devtunnel] Connecting to tunnel ${session.tunnelId} (binary: ${devtunnelBin})`
        );

        // Count expected ports so we know when all are forwarded
        const expectedPorts = new Set<number>();
        if (session.sshPort) { expectedPorts.add(session.sshPort); }
        if (session.remoteFusePort) { expectedPorts.add(session.remoteFusePort); }

        return new Promise<Map<number, number> | undefined>((resolve) => {
            let resolved = false;
            const portMap = new Map<number, number>();

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    if (portMap.size > 0) {
                        // Got some ports, resolve with what we have
                        this.ctx.outputChannel.appendLine(`[devtunnel] Timeout but got ${portMap.size} port(s), proceeding`);
                        session._devtunnelPortMap = portMap;
                        resolve(portMap);
                    } else {
                        this.ctx.outputChannel.appendLine('[devtunnel] Timed out waiting for port forwarding');
                        resolve(undefined);
                    }
                }
            }, 60_000);

            const tunnelProc = spawn(devtunnelBin, [
                'connect', session.tunnelId!,
                '--access-token', session.tunnelToken!,
            ], {
                stdio: ['ignore', 'pipe', 'pipe'] as const,
            });

            tunnelProc.on('error', (err: Error) => {
                this.ctx.outputChannel.appendLine(`[devtunnel] ERROR: spawn failed: ${err.message}`);
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(undefined);
                }
            });

            if (!tunnelProc.pid) {
                this.ctx.outputChannel.appendLine('[devtunnel] ERROR: process did not start (no PID)');
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(undefined);
                }
                return;
            }

            session.devtunnelConnectPid = tunnelProc.pid;
            saveSessions(this.ctx);

            // Parse: "SSH: Forwarding from 127.0.0.1:<local> to host port <remote>."
            const forwardingRe = /Forwarding from 127\.0\.0\.1:(\d+) to host port (\d+)/;

            const checkOutput = (text: string) => {
                for (const line of text.split('\n')) {
                    const m = line.match(forwardingRe);
                    if (m) {
                        const localPort = parseInt(m[1], 10);
                        const remotePort = parseInt(m[2], 10);
                        portMap.set(remotePort, localPort);
                        this.ctx.outputChannel.appendLine(`[devtunnel] Port mapped: remote ${remotePort} → local ${localPort}`);
                    }
                }
                // Resolve once we've seen forwarding lines for all expected ports
                if (!resolved && portMap.size > 0 && (expectedPorts.size === 0 || [...expectedPorts].every(p => portMap.has(p)))) {
                    resolved = true;
                    clearTimeout(timeout);
                    session._devtunnelPortMap = portMap;
                    this.ctx.outputChannel.appendLine('[devtunnel] All expected ports forwarded');
                    resolve(portMap);
                }
            };

            tunnelProc.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                this.ctx.outputChannel.appendLine(`[devtunnel] ${text.trimEnd()}`);
                checkOutput(text);
            });

            tunnelProc.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                this.ctx.outputChannel.appendLine(`[devtunnel/err] ${text.trimEnd()}`);
                checkOutput(text);
            });

            tunnelProc.on('close', (code: number | null) => {
                this.ctx.outputChannel.appendLine(`[devtunnel] connect exited (code ${code})`);
                const s = findRuntime(sessionId, this.ctx)?.runtime;
                if (s) {
                    s.devtunnelConnectPid = undefined;
                    s.sshTunnelLocalPort = undefined;
                    s._devtunnelPortMap = undefined;
                }
                this._removeSshConfigEntry(sessionId, `cs-session-${sessionId}`);
                saveSessions(this.ctx);
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(undefined);
                }
            });
        });
    }

    /**
     * Kill FUSE mount process, Dev Tunnel connect, and SSH tunnel for a session.
     */
    private cleanupFuseMount(session: Runtime) {
        if (session.fuseMountPid) {
            try { process.kill(session.fuseMountPid); } catch { /* already dead */ }
            session.fuseMountPid = undefined;
            session.localMountPath = undefined;
        }
        if (session.devtunnelConnectPid) {
            try { process.kill(session.devtunnelConnectPid); } catch { /* already dead */ }
            session.devtunnelConnectPid = undefined;
        }
        if (session.fuseTunnelPid) {
            try { process.kill(session.fuseTunnelPid); } catch { /* already dead */ }
            session.fuseTunnelPid = undefined;
        }
        if (session.sshTunnelPid) {
            try { process.kill(session.sshTunnelPid); } catch { /* already dead */ }
            session.sshTunnelPid = undefined;
            session.sshTunnelLocalPort = undefined;
        }
    }

    /**
     * Kill local FUSE server process and delete its devtunnel (Mac→HPC mount).
     */
    private cleanupLocalFuseServer(session: Runtime) {
        if (session.localFuseServerPid) {
            try { process.kill(session.localFuseServerPid); } catch { /* already dead */ }
            session.localFuseServerPid = undefined;
        }
        if (session.localFuseTunnelId) {
            const dtBin = this._resolveDevTunnelBin();
            if (dtBin) { spawn(dtBin, ['delete', `ls-fuse-${session.id}`, '-f'], { stdio: 'ignore', detached: true }).unref(); }
            session.localFuseTunnelId = undefined;
            session.localFuseConnectToken = undefined;
            session.localFusePort = undefined;
        }
    }

    /**
     * Stop a remote SLURM session by cancelling the job via scancel.
     */
    private async stopRemoteSession(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session || !session.slurmJobId) {
            vscode.window.showErrorMessage('Session not found or no SLURM job ID.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Stopping session on ${session.host}`,
            cancellable: false,
        }, async (progress) => {
            // 1. Teardown: sync-back, cleanup connections, delete tunnel, clear fields
            progress.report({ message: 'Syncing remote changes back...' });
            session.status = 'Stopping';
            saveSessions(this.ctx);
            this._sendRuntimeUpdates();
            await this._teardownSession(session, sessionId, 'stop');

            // 2. Cancel SLURM job
            this.ctx.outputChannel.appendLine(`\n--- Cancelling SLURM job ${session.slurmJobId} on ${session.host} ---`);
            progress.report({ message: 'Cancelling SLURM job...' });
            try {
                const result = await this.ctx.ssh.runRemoteCommand(session.host, `scancel ${session.slurmJobId}`);
                if (result.code === 0) {
                    this.ctx.outputChannel.appendLine(`Job ${session.slurmJobId} cancelled.`);
                } else {
                    this.ctx.outputChannel.appendLine(`scancel failed: ${result.stderr}`);
                }
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`Error cancelling job: ${err.message}`);
            }

            // 3. Clean remote session dir (best-effort, don't block)
            progress.report({ message: 'Cleaning remote workspace...' });
            try {
                const rmTargets = this._filesystemSyncEnabled
                    ? `~/sessions/${sessionId} ~/overlay/${sessionId}`
                    : `~/sessions/${sessionId}`;
                await this.ctx.ssh.runRemoteCommand(session.host, `rm -rf ${rmTargets}`);
            } catch { /* best-effort */ }

            session.status = 'Completed';
            this.stopSessionLogStream(sessionId);
            saveSessions(this.ctx);
            this.refresh();
        });

        // If we're in a remote window connected to this session, switch back to local
        if (this.isRemoteWindow) {
            const activeSession = detectActiveSession(this.ctx.workspaces, this.ctx.windowId);
            if (activeSession?.id === sessionId) {
                const localPath = this._getLocalSwitchPath(session);
                vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(localPath), { forceNewWindow: false });
            }
        }
    }

    /**
     * Handle an expired session: clean up tunnels and SSH config.
     */
    private async _handleSessionExpired(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session) { return; }

        this.ctx.outputChannel.appendLine(`[session] Session ${sessionId} expired, cleaning up`);

        // 1. Full teardown: sync-back, cleanup connections, delete tunnel, clear fields
        session.status = 'Stopping';
        saveSessions(this.ctx);
        this._sendRuntimeUpdates();
        await this._teardownSession(session, sessionId, 'expire');
        session.status = 'Completed';

        // 2. Clean remote session dir (best-effort)
        if (session.host && !session.isLocal) {
            try {
                const rmTargets = this._filesystemSyncEnabled
                    ? `~/sessions/${sessionId} ~/overlay/${sessionId}`
                    : `~/sessions/${sessionId}`;
                await this.ctx.ssh.runRemoteCommand(session.host, `rm -rf ${rmTargets}`);
            } catch { /* best-effort */ }
        }

        this.stopSessionLogStream(sessionId);
        saveSessions(this.ctx);
        this.refresh();

        // Prompt switch to local if we're in this session's remote window
        if (this.isRemoteWindow) {
            const activeSession = detectActiveSession(this.ctx.workspaces, this.ctx.windowId);
            if (activeSession?.id === sessionId) {
                this._promptSwitchToLocal(session, 'Session expired. Remote connection will be lost.');
            }
        }
    }

    private async stopLocalSession(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session) { return; }

        // 1. Clean up connections (mutagen, tunnel, SSH config)
        await this._cleanupSessionConnections(session, sessionId);

        // 2. Kill linkspan process
        const proc = this.ctx.localProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this.ctx.localProcesses.delete(sessionId);
        } else if (session.localPid) {
            try { process.kill(session.localPid, 'SIGTERM'); } catch { /* already dead */ }
        }

        // 4. Delete session tunnel (safety net)
        await this._deleteTunnel(session);

        // 4. Clear all fields and credentials
        session.status = 'Completed';
        session.script = undefined;
        session.localPid = undefined;
        session.tunnelUrl = undefined;
        session.tunnelToken = undefined;
        session.tunnelId = undefined;
        session.sshPort = undefined;
        session.logPort = undefined;
        session.localWorkdir = undefined;
        saveSessions(this.ctx);
        this.refresh();
    }

    /**
     * Refresh session statuses by querying squeue on the remote host.
     * Only checks sessions that still need setup monitoring.
     * RUNNING → Active, PENDING → Pending, no output → completed/removed.
     */
    private async refreshSessions() {
        // Only check sessions that still need setup polling
        const sessionsToCheck = allRuntimes(this.ctx.workspaces).filter(s => this._sessionNeedsSetupPolling(s));
        if (sessionsToCheck.length === 0) {
            this._sendRuntimeUpdates();
            this._updateStatusBar();
            return;
        }

        for (const session of sessionsToCheck) {
            try {
                const oldStatus = session.status;
                const hadTunnelUrl = !!session.tunnelUrl;

                // Prefer tunnel-based health check when tunnel is established
                if (session.tunnelUrl) {
                    const healthy = await this._checkLinkspanHealth(session);
                    if (healthy) {
                        session.status = 'Active';
                        session.errorMessage = undefined;
                    } else {
                        // Linkspan unreachable — fall back to SLURM/process check
                        await this._checkJobViaSsh(session);
                    }
                } else {
                    // No tunnel yet — use SSH-based checks
                    await this._checkJobViaSsh(session);
                }

                // Clean up resources for terminal sessions
                if (session.status === 'Failed' || session.status === 'Completed') {
                    await this._teardownSession(session, session.id, 'poll');
                }

                // Record status transitions and handle remote window disconnect
                if (session.status !== oldStatus) {
                    this.ctx.metrics.record('job_status_change', session.status === 'Failed' ? 'failure' : 'success', {
                        job_id_slurm: session.slurmJobId,
                        old_status: oldStatus,
                        new_status: session.status,
                        cluster: session.host,
                    });

                    // If this session just became terminal and we're in its remote window, prompt switch
                    if ((session.status === 'Failed' || session.status === 'Completed') && this.isRemoteWindow) {
                        const activeSession = detectActiveSession(this.ctx.workspaces, this.ctx.windowId);
                        if (activeSession?.id === session.id) {
                            const reason = session.status === 'Failed'
                                ? `Session failed: ${session.errorMessage || 'Unknown error'}`
                                : 'Session completed. Remote connection will be lost.';
                            this._promptSwitchToLocal(session, reason);
                        }
                    }
                }

                // Poll linkspan workflow status to capture variables
                // (tunnel_url, tunnel_token, ssh_port) regardless of job state.
                await pollLinkspanWorkflow(session, this.ctx);

                // Event-driven tunnel connect: trigger once when tunnelUrl first appears
                if (!hadTunnelUrl && session.tunnelUrl && session.tunnelToken && session.tunnelId
                    && session.status === 'Active' && !session._portMap && !session.connectionId) {
                    try {
                        this.ctx.outputChannel.appendLine(`[poll] Tunnel URL discovered for ${session.id}, auto-connecting...`);
                        const portMap = await this._connectViaTunnel(session.id, session);
                        if (portMap && session.logPort && !this.ctx.logTailProcesses.has(session.id)) {
                            this.toggleSessionLogStream(session.id);
                        }
                    } catch (err: any) {
                        this.ctx.outputChannel.appendLine(`[poll] Auto-connect tunnel failed for ${session.id}: ${err.message}`);
                    }
                }

                // Auto-switch if runtime just became active and has switchOnReady
                if (session.switchOnReady && session.status === 'Active' && session.tunnelUrl) {
                    session.switchOnReady = false;
                    saveSessions(this.ctx);
                    try {
                        await this.switchToRemote(session.id);
                    } catch (err: any) {
                        this.ctx.outputChannel.appendLine(`[auto-switch] Failed to switch to ${session.id}: ${err.message}`);
                    }
                }
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[poll] Error checking session ${session.id}: ${err.message}`);
            }
        }

        saveSessions(this.ctx);
        this._sendRuntimeUpdates();
        this._updateStatusBar();

        // Push active sessions metadata to local linkspan
        const workspaceSessions = new Map<string, any[]>();
        for (const session of allRuntimes(this.ctx.workspaces)) {
            if (!session.localWorkdir) { continue; }
            if (!workspaceSessions.has(session.localWorkdir)) {
                workspaceSessions.set(session.localWorkdir, []);
            }
            workspaceSessions.get(session.localWorkdir)!.push({
                id: session.id,
                host: session.host,
                tunnelUrl: session.tunnelUrl,
                status: session.status,
            });
        }
        for (const [ws, sessions] of workspaceSessions) {
            await this.ctx.localLinkspan.setMetadata(ws, 'sessions', sessions);
        }
    }

    /**
     * SSH-based job status check (squeue for SLURM, kill -0 for plain processes).
     * Used as fallback when tunnel health check fails or tunnel not yet established.
     */
    private async _checkJobViaSsh(session: Runtime): Promise<void> {
        if (session.noSlurm) {
            const pid = session.slurmJobId?.replace('pid-', '');
            if (pid) {
                const result = await this.ctx.ssh.runRemoteCommand(session.host, `kill -0 ${pid} 2>/dev/null && echo RUNNING || echo STOPPED`);
                if (result.stdout.trim() === 'RUNNING') {
                    session.status = 'Active';
                    session.errorMessage = undefined;
                } else {
                    session.status = 'Completed';
                    session.errorMessage = undefined;
                }
            }
        } else {
            const squeueStart = Date.now();
            const result = await this.ctx.ssh.runRemoteCommand(session.host, `squeue -j ${session.slurmJobId} -h -o "%T %N"`);
            this.ctx.metrics.record('sinfo_fetch', 'success', { cluster: session.host, raw_output_truncated: result.stdout.slice(0, 200) }, Date.now() - squeueStart);
            const parts0 = result.stdout.trim().split(/\s+/);
            const state = parts0[0] || '';
            const nodeName = parts0[1] || '';
            if (result.code === 0 && state) {
                if (state === 'RUNNING') {
                    session.status = 'Active';
                    session.errorMessage = undefined;
                    if (nodeName && !session.computeNode) { session.computeNode = nodeName; }
                } else if (state === 'PENDING' || state === 'CONFIGURING') {
                    session.status = 'Pending';
                    session.errorMessage = undefined;
                } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT' || state === 'NODE_FAIL' || state === 'OUT_OF_MEMORY') {
                    session.status = 'Failed';
                    session.errorMessage = `Job ${state}`;
                }
            } else {
                try {
                    const sacctResult = await this.ctx.ssh.runRemoteCommand(session.host, `sacct -j ${session.slurmJobId} -n -o State%20,ExitCode,Reason%40 --parsable2 2>/dev/null | head -1`);
                    const parts = sacctResult.stdout.trim().split('|');
                    const sacctState = (parts[0] || '').trim();
                    if (sacctState === 'COMPLETED') {
                        session.status = 'Completed';
                        session.errorMessage = undefined;
                    } else if (sacctState) {
                        session.status = 'Failed';
                        const reason = parts[2] && parts[2] !== 'None' ? `${sacctState} — ${parts[2]}` : sacctState;
                        session.errorMessage = reason;
                    } else {
                        session.status = 'Failed';
                        session.errorMessage = 'Job no longer in queue';
                    }
                } catch {
                    session.status = 'Failed';
                    session.errorMessage = 'Job no longer in queue';
                }
            }
        }
    }

    /**
     * Check if linkspan is alive by hitting /api/v1/health through the tunnel.
     */
    private async _checkLinkspanHealth(session: Runtime): Promise<boolean> {
        if (!session.tunnelUrl) { return false; }
        const baseUrl = session.tunnelUrl.replace(/\/$/, '');
        const url = `${baseUrl}/api/v1/health`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const resp = await fetch(url, {
                signal: controller.signal,
                headers: session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {},
            });
            clearTimeout(timeout);
            if (!resp.ok) {
                this.ctx.outputChannel.appendLine(`[health] ${url} returned ${resp.status}`);
            }
            return resp.ok;
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[health] ${url} failed: ${err.message}`);
            return false;
        }
    }

    // TODO: Refactor this function. Too big
    /**
     * Switch the current window to the remote session.
     * For local sessions, connects via ssh-remote+cs-tunnel-{id}.
     * For remote sessions with compute node SSH, sets up port forwarding
     * through the login node and connects via ssh-remote+cs-session-{id}.
     * For remote sessions without compute node info, connects via ssh-remote+{host}.
     */
    private async switchToRemote(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }
        // Don't re-activate completed or failed sessions — user must explicitly restart
        if (session.status === 'Completed' || session.status === 'Failed') {
            this._sendRuntimeUpdates();
            return;
        }
        // If runtime is idle (not yet launched), launch it first then auto-switch when ready
        if (!session.slurmJobId && session.status === 'Idle') {
            // Require local linkspan to be running before launching
            if (session.localWorkdir) {
                const localInfo = this.ctx.localLinkspan.get(session.localWorkdir);
                if (!localInfo?.tunnelId) {
                    vscode.window.showErrorMessage('Local linkspan is not running. Start it first via the Sessions panel or "CyberShuttle: Start Linkspan" command.');
                    return;
                }
            }
            session.switchOnReady = true;
            session.status = 'Submitting';
            saveSessions(this.ctx);
            this._sendRuntimeUpdates();
            try {
                const creds = await this.ctx.tunnelManager.getCredentials();
                const localInfo = session.localWorkdir ? this.ctx.localLinkspan.get(session.localWorkdir) : undefined;
                const localParams = {
                    localTunnelId: localInfo?.tunnelId,
                    localTunnelToken: localInfo?.tunnelToken,
                    localSshPort: localInfo?.sshPort,
                    localWorkspace: session.localWorkdir,
                };
                const script = this.generateSlurmScript({
                    cpus: session.cpus,
                    memory: session.memory,
                    gpu: session.gpu,
                    wallTime: session.wallTime,
                    queue: session.queue,
                    allocation: session.allocation,
                    authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, filesystemSync: this._filesystemSyncEnabled, ...localParams,
                });
                session.script = script;
                await this.submitJob(session.id);
            } catch (err: any) {
                session.status = 'Failed';
                session.errorMessage = err.message;
                session.switchOnReady = false;
                saveSessions(this.ctx);
                this._sendRuntimeUpdates();
            }
            return;
        }
        // If runtime is active but has no tunnel (stale), re-launch it
        const isStaleActive = session.status === 'Active' && !session.tunnelUrl;
        if (session.slurmJobId && isStaleActive) {
            // Require local linkspan to be running before re-launching
            if (session.localWorkdir) {
                const localInfo = this.ctx.localLinkspan.get(session.localWorkdir);
                if (!localInfo?.tunnelId) {
                    vscode.window.showErrorMessage('Local linkspan is not running. Start it first via the Sessions panel or "CyberShuttle: Start Linkspan" command.');
                    return;
                }
            }
            // Clear old job state
            session.slurmJobId = undefined;
            session.tunnelUrl = undefined;
            session.tunnelToken = undefined;
            session.tunnelId = undefined;
            session.sshPort = undefined;
            session.logPort = undefined;
            session.computeNode = undefined;
            session.errorMessage = undefined;
            session.script = undefined;
            // Now treat it like an Idle runtime
            session.switchOnReady = true;
            session.status = 'Submitting';
            saveSessions(this.ctx);
            this._sendRuntimeUpdates();
            try {
                const creds = await this.ctx.tunnelManager.getCredentials();
                const localInfo = session.localWorkdir ? this.ctx.localLinkspan.get(session.localWorkdir) : undefined;
                const localParams = {
                    localTunnelId: localInfo?.tunnelId,
                    localTunnelToken: localInfo?.tunnelToken,
                    localSshPort: localInfo?.sshPort,
                    localWorkspace: session.localWorkdir,
                };
                const script = this.generateSlurmScript({
                    cpus: session.cpus, memory: session.memory, gpu: session.gpu,
                    wallTime: session.wallTime, queue: session.queue, allocation: session.allocation,
                    authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, filesystemSync: this._filesystemSyncEnabled, ...localParams,
                });
                session.script = script;
                await this.submitJob(session.id);
            } catch (err: any) {
                session.status = 'Failed';
                session.errorMessage = err.message;
                session.switchOnReady = false;
                saveSessions(this.ctx);
                this._sendRuntimeUpdates();
            }
            return;
        }
        // Don't switch to a remote session that doesn't have tunnel info yet
        if (!session.isLocal && !session.sshPort) {
            vscode.window.showWarningMessage('Session is still setting up its tunnel. Please wait for the tunnel to be ready.');
            this._sendRuntimeUpdates();
            return;
        }
        this.ctx.switchingSessionId = sessionId;
        this._sendRuntimeUpdates();
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Connecting to ${session.host}`,
                cancellable: false,
            }, async (progress) => {
                // Save current local workspace folder
                const folder = vscode.workspace.workspaceFolders?.[0];
                if (folder && folder.uri.scheme === 'file') {
                    session.localWorkspaceFolder = folder.uri.fsPath;
                }
                // Resolve remote workspace path (~ is resolved later via SSH to the actual target)
                let remotePath = session.connectedRemotePath;
                if (!remotePath && this._filesystemSyncEnabled) {
                    if (session.isLocal && session.localWorkdir) {
                        remotePath = `${os.homedir()}/sessions/${sessionId}`;
                    } else {
                        remotePath = this.ctx.cachedRemoteHome.get(session.host) || '~/sessions/' + sessionId;
                    }
                    session.connectedRemotePath = remotePath;
                }
                saveSessions(this.ctx);
                progress.report({ message: 'Opening remote folder...' });
                if (session.isLocal) {
                    // Local sessions: connect via SSH on localhost
                    const hostAlias = `cs-tunnel-${sessionId}`;
                    if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshPort!, 'user')) {
                        return;
                    }
                    const openNewWindow = !this._filesystemSyncEnabled;
                    this.ctx.outputChannel.appendLine(`[switch] Opening remote${openNewWindow ? ' (new window, no folder)' : ''}: authority=ssh-remote+${hostAlias}, path=${remotePath || '(none)'}`);
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${hostAlias}`,
                        path: remotePath || '/',
                    }), openNewWindow ? { forceNewWindow: true } : { forceNewWindow: false });
                } else if (session.sshPort && session.tunnelId && session.tunnelToken) {
                    // Remote sessions: forward SSH port via tunnel (bypasses compute node firewall)
                    const hostAlias = `cs-session-${sessionId}`;
                    // --- Pre-flight: ensure tunnel is connected with working ports ---
                    const connectTunnel = async (): Promise<boolean> => {
                        // Clear stale port if connection is gone
                        if (session.sshTunnelLocalPort && !session.connectionId) {
                            session.sshTunnelLocalPort = undefined;
                        }
                        // Connect if needed
                        if (!session.sshTunnelLocalPort) {
                            progress.report({ message: 'Connecting to tunnel...' });
                            const portMap = await this._connectViaTunnel(sessionId, session);
                            if (!portMap) {
                                return false;
                            }
                            const localSshPort = portMap.get(session.sshPort!);
                            if (!localSshPort) {
                                this.ctx.outputChannel.appendLine(`[preflight] SSH port ${session.sshPort} not in port map`);
                                return false;
                            }
                            session.sshTunnelLocalPort = localSshPort;
                            saveSessions(this.ctx);
                            // Auto-start log streaming if log port is available
                            if (session.logPort && !this.ctx.logTailProcesses.has(sessionId)) {
                                this.toggleSessionLogStream(sessionId);
                            }
                        }
                        return true;
                    };
                    // TCP probe: verify port is actually reachable
                    const tcpProbe = (port: number, timeoutMs = 3000): Promise<boolean> => {
                        return new Promise((resolve) => {
                            const sock = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
                            sock.on('connect', () => { sock.destroy(); resolve(true); });
                            sock.on('error', () => { sock.destroy(); resolve(false); });
                            sock.on('timeout', () => { sock.destroy(); resolve(false); });
                        });
                    };
                    // Verify the remote session is still alive before connecting
                    if (session.slurmJobId) {
                        progress.report({ message: 'Checking session status...' });
                        // Prefer tunnel-based health check
                        if (session.tunnelUrl) {
                            const healthy = await this._checkLinkspanHealth(session);
                            if (healthy) {
                                this.ctx.outputChannel.appendLine(`[preflight] Linkspan is healthy`);
                            } else {
                                this.ctx.outputChannel.appendLine(`[preflight] Linkspan health check failed, falling back to SSH`);
                                await this._checkJobViaSsh(session);
                                if (session.status === 'Failed' || session.status === 'Completed') {
                                    vscode.window.showErrorMessage('The remote job has ended. Cannot connect.');
                                    return;
                                }
                            }
                        } else {
                            try {
                                await this._checkJobViaSsh(session);
                                if (session.status === 'Failed' || session.status === 'Completed') {
                                    vscode.window.showErrorMessage('The remote job has ended. Cannot connect.');
                                    return;
                                }
                                this.ctx.outputChannel.appendLine(`[preflight] Job ${session.slurmJobId} is still running`);
                            } catch (err: any) {
                                this.ctx.outputChannel.appendLine(`[preflight] Failed to check job status: ${err.message}`);
                            }
                        }
                    }
                    // First attempt to connect
                    progress.report({ message: 'Verifying tunnel...' });
                    if (!await connectTunnel()) {
                        vscode.window.showErrorMessage('Failed to connect to tunnel. Check the Cybershuttle output channel for details.');
                        return;
                    }
                    // TCP probe the forwarded SSH port
                    let portReachable = await tcpProbe(session.sshTunnelLocalPort!);
                    if (!portReachable) {
                        this.ctx.outputChannel.appendLine(`[preflight] TCP probe to 127.0.0.1:${session.sshTunnelLocalPort} failed, reconnecting tunnel`);
                        // Disconnect and retry once
                        await this._disconnectTunnel(session);
                        session.sshTunnelLocalPort = undefined;
                        progress.report({ message: 'Reconnecting tunnel...' });
                        if (!await connectTunnel()) {
                            vscode.window.showErrorMessage('Failed to reconnect tunnel after port probe failure.');
                            return;
                        }
                        portReachable = await tcpProbe(session.sshTunnelLocalPort!);
                        if (!portReachable) {
                            vscode.window.showErrorMessage(`Tunnel connected but SSH port ${session.sshTunnelLocalPort} is not reachable. The remote session may have ended.`);
                            return;
                        }
                    }
                    this.ctx.outputChannel.appendLine(`[preflight] TCP probe to 127.0.0.1:${session.sshTunnelLocalPort} succeeded`);
                    // --- Write SSH config ---
                    if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshTunnelLocalPort!, 'user')) {
                        return;
                    }
                    // --- Verify SSH + resolve ~ in a single round trip ---
                    progress.report({ message: 'Verifying SSH to compute node...' });
                    const sshCheck = this._sshExec(hostAlias, 'echo __CS_SSH_OK__ && echo HOME_IS=$HOME', { timeout: 15_000 });
                    if (!sshCheck.ok || !sshCheck.stdout.includes('__CS_SSH_OK__')) {
                        this.ctx.outputChannel.appendLine(`[preflight] SSH check failed: ${sshCheck.stdout}`);
                        vscode.window.showErrorMessage('Cannot SSH to compute node through tunnel. The remote session may have ended or SSH is not ready yet.');
                        return;
                    }
                    this.ctx.outputChannel.appendLine('[preflight] SSH to compute node verified');
                    const homeMatch = sshCheck.stdout.match(/HOME_IS=(.+)/);
                    if (homeMatch && homeMatch[1].startsWith('/') && remotePath!.startsWith('~')) {
                        remotePath = remotePath!.replace(/^~/, homeMatch[1].trim());
                        session.connectedRemotePath = remotePath;
                        saveSessions(this.ctx);
                    }
                    const openNewWindow = !this._filesystemSyncEnabled;

                    // --- Wait for remote linkspan + verify workspace in single poll ---
                    // (only when filesystem sync is on — overlay dir must exist before opening)
                    if (this._filesystemSyncEnabled && session.slurmJobId) {
                        progress.report({ message: 'Waiting for remote workspace...' });
                        const logPrefix = 'linkspan-session-';
                        const logId = session.noSlurm ? sessionId : session.slurmJobId;
                        const logFile = `$HOME/.cybershuttle/logs/${logPrefix}${logId}.err`;
                        const pollCmd = [
                            `OK=$(grep -c 'finished successfully' ${logFile} 2>/dev/null || echo 0)`,
                            `ERR=$(grep -c 'workflow step' ${logFile} 2>/dev/null || echo 0)`,
                            `DIR=$(test -d '${remotePath}' && echo Y || echo N)`,
                            `echo OK=$OK ERR=$ERR DIR=$DIR`,
                        ].join('; ');
                        const maxWait = 60;
                        let linkspanReady = false;
                        for (let i = 0; i < maxWait; i++) {
                            const poll = this._sshExec(hostAlias, pollCmd);
                            this.ctx.outputChannel.appendLine(`[switch] Poll: ${poll.stdout}`);
                            const okMatch = poll.stdout.match(/OK=(\d+)/);
                            const errMatch = poll.stdout.match(/ERR=(\d+)/);
                            if (okMatch && parseInt(okMatch[1], 10) > 0) {
                                this.ctx.outputChannel.appendLine(`[switch] Remote linkspan finished after ${i * 2}s`);
                                linkspanReady = true;
                                if (poll.stdout.includes('DIR=N')) {
                                    this.ctx.outputChannel.appendLine(`[preflight] Remote workspace directory ${remotePath} does not exist`);
                                    vscode.window.showErrorMessage(`Remote workspace directory does not exist: ${remotePath}`);
                                    return;
                                }
                                break;
                            }
                            if (errMatch && parseInt(errMatch[1], 10) > 0) {
                                this.ctx.outputChannel.appendLine('[switch] Remote linkspan has errors');
                                const tail = this._sshExec(hostAlias, `tail -5 ${logFile} 2>/dev/null`);
                                if (tail.stdout) {
                                    this.ctx.outputChannel.appendLine(`[switch] Remote linkspan tail:\n${tail.stdout}`);
                                }
                            }
                            if (i === maxWait - 1) {
                                this.ctx.outputChannel.appendLine('[switch] Timed out waiting for remote linkspan');
                            }
                            await new Promise(r => setTimeout(r, 2000));
                        }
                        if (!linkspanReady) {
                            vscode.window.showErrorMessage('Remote workspace setup timed out. The remote linkspan may have failed. Check the Cybershuttle output channel.');
                            return;
                        }
                    } else if (!this._filesystemSyncEnabled && session.slurmJobId) {
                        // No filesystem sync — just wait for linkspan workflow to finish (tunnel ready)
                        progress.report({ message: 'Waiting for remote session...' });
                        const logPrefix = 'linkspan-session-';
                        const logId = session.noSlurm ? sessionId : session.slurmJobId;
                        const logFile = `$HOME/.cybershuttle/logs/${logPrefix}${logId}.err`;
                        const pollCmd = [
                            `OK=$(grep -c 'finished successfully' ${logFile} 2>/dev/null || echo 0)`,
                            `ERR=$(grep -c 'workflow step' ${logFile} 2>/dev/null || echo 0)`,
                            `echo OK=$OK ERR=$ERR`,
                        ].join('; ');
                        const maxWait = 60;
                        for (let i = 0; i < maxWait; i++) {
                            const poll = this._sshExec(hostAlias, pollCmd);
                            this.ctx.outputChannel.appendLine(`[switch] Poll: ${poll.stdout}`);
                            const okMatch = poll.stdout.match(/OK=(\d+)/);
                            if (okMatch && parseInt(okMatch[1], 10) > 0) {
                                this.ctx.outputChannel.appendLine(`[switch] Remote linkspan finished after ${i * 2}s`);
                                break;
                            }
                            if (i === maxWait - 1) {
                                this.ctx.outputChannel.appendLine('[switch] Timed out waiting for remote linkspan');
                                vscode.window.showErrorMessage('Remote session setup timed out. Check the Cybershuttle output channel.');
                                return;
                            }
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    }

                    // Inject .vscode/settings.json (only when filesystem sync is on and we have a target path)
                    if (this._filesystemSyncEnabled && remotePath) {
                        progress.report({ message: 'Configuring remote workspace...' });
                        try {
                            const remoteSettings = JSON.stringify({
                                'files.watcherExclude': { '**': true },
                                'files.enableTrash': false,
                                'search.followSymlinks': false,
                                'search.exclude': {
                                    '**/node_modules': true,
                                    '**/.git': true,
                                    '**/dist': true,
                                    '**/build': true,
                                    '**/__pycache__': true,
                                },
                                'git.enabled': false,
                                'git.autoRepositoryDetection': false,
                                'extensions.autoUpdate': false,
                                'typescript.disableAutomaticTypeAcquisition': true,
                                'npm.autoDetect': 'off',
                            }, null, 2);
                            const inject = this._sshExec(
                                hostAlias,
                                `mkdir -p '${remotePath}/.vscode' && cat > '${remotePath}/.vscode/settings.json'`,
                                { input: remoteSettings },
                            );
                            if (inject.ok) {
                                this.ctx.outputChannel.appendLine('[switch] Injected remote .vscode/settings.json');
                            } else {
                                this.ctx.outputChannel.appendLine(`[switch] Failed to inject remote settings`);
                            }
                        } catch (err: any) {
                            this.ctx.outputChannel.appendLine(`[switch] Failed to inject remote settings: ${err.message}`);
                        }
                    }

                    this.ctx.outputChannel.appendLine(`[switch] Opening remote${openNewWindow ? ' (new window, no folder)' : ''}: authority=ssh-remote+${hostAlias}, path=${remotePath || '(none)'}`);
                    if (openNewWindow) {
                        // No filesystem sync: open empty remote window — user picks folder themselves
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                            scheme: 'vscode-remote',
                            authority: `ssh-remote+${hostAlias}`,
                            path: '/',
                        }), { forceNewWindow: true });
                    } else {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                            scheme: 'vscode-remote',
                            authority: `ssh-remote+${hostAlias}`,
                            path: remotePath!,
                        }), { forceNewWindow: false });
                    }
                } else {
                    // Remote sessions without compute node: connect to login node
                    const openNewWindow = !this._filesystemSyncEnabled;
                    this.ctx.outputChannel.appendLine(`[switch] Opening remote${openNewWindow ? ' (new window, no folder)' : ''}: authority=ssh-remote+${session.host}, path=${remotePath || '(none)'}`);
                    if (openNewWindow) {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                            scheme: 'vscode-remote',
                            authority: `ssh-remote+${session.host}`,
                            path: '/',
                        }), { forceNewWindow: true });
                    } else {
                        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                            scheme: 'vscode-remote',
                            authority: `ssh-remote+${session.host}`,
                            path: remotePath!,
                        }), { forceNewWindow: false });
                    }
                }
            });
        } finally {
            this.ctx.switchingSessionId = undefined;
            this._sendRuntimeUpdates();
        }
    }

    /**
     * Switch back to the local workspace folder from a remote session.
     */
    private async switchToLocal(sessionId: string) {
        const session = findRuntime(sessionId, this.ctx)?.runtime;
        if (!session) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }

        const localPath = this._getLocalSwitchPath(session);

        vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(localPath),
            { forceNewWindow: false }
        );
    }

    /**
     * Open the workspace folder for a Local session in the current window.
     */
    private switchToWindow(sessionId: string) {
        const found = findRuntime(sessionId, this.ctx);
        if (!found) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }
        const dirPath = found.workspace.directoryPath;
        if (!dirPath || dirPath === 'unknown') {
            vscode.window.showErrorMessage('Session not found or no workspace path.');
            return;
        }
        const uri = dirPath.includes('://')
            ? vscode.Uri.parse(dirPath)
            : vscode.Uri.file(dirPath);
        vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
    }

    /**
     * Show a quick pick to switch between sessions (Cmd+Shift+P command).
     */
    async handleSwitchSession() {
        const activeSession = detectActiveSession(this.ctx.workspaces, this.ctx.windowId);
        const allRuntimesList = allRuntimes(this.ctx.workspaces);
        if (allRuntimesList.length === 0) {
            vscode.window.showInformationMessage('No sessions available.');
            return;
        }
        const items: (vscode.QuickPickItem & { _sessionId: string; _isLocal: boolean; _isRemote: boolean })[] = [];
        for (const rt of allRuntimesList) {
            let description = rt.host;
            let detail = '';
            const isCurrent = activeSession?.id === rt.id || (rt.status === 'Local' && rt.windowId === this.ctx.windowId);
            if (rt.isLocal) {
                description = 'Local';
                detail = rt.localWorkdir || rt.localWorkspaceFolder || '';
            } else {
                const statusLabel = rt.status === 'Active' && rt.tunnelUrl ? 'Active' : rt.status;
                description = `${rt.host} — ${statusLabel}`;
                detail = rt.connectedRemotePath || '';
            }
            if (isCurrent) {
                description += ' (current)';
            }
            items.push({
                label: rt.isLocal ? '$(terminal) Local Session' : `$(remote) ${rt.host}`,
                description,
                detail,
                picked: isCurrent,
                _sessionId: rt.id,
                _isLocal: !!rt.isLocal,
                _isRemote: !rt.isLocal && rt.status === 'Active' && !!rt.tunnelUrl,
            });
        }
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a session to switch to',
            title: 'Switch Session',
        });
        if (!selected) {
            return;
        }
        const sessionId = selected._sessionId;
        if (selected._isLocal) {
            this.switchToLocal(sessionId);
        } else if (selected._isRemote) {
            this.switchToRemote(sessionId);
        } else {
            this.switchToWindow(sessionId);
        }
    }

    /**
     * Get the local workspace path for switching back from a remote session.
     */
    private _getLocalSwitchPath(session: Runtime | undefined): string {
        if (session?.localWorkspaceFolder) {
            return session.localWorkspaceFolder;
        }
        // Try to find the workspace's directory path
        const found = session ? findRuntime(session.id, this.ctx) : undefined;
        if (found?.workspace.directoryPath && found.workspace.directoryPath !== 'unknown') {
            return found.workspace.directoryPath;
        }
        return os.homedir();
    }

    /**
     * Show "Remote connection lost" notification with Switch to Local action.
     */
    private async _promptSwitchToLocal(session: Runtime, reason: string) {
        const localPath = this._getLocalSwitchPath(session);
        this.ctx.outputChannel.appendLine(`[session] ${reason} — prompting switch to local (${localPath})`);
        const action = await vscode.window.showWarningMessage(`${reason}`, 'Switch to Local');
        if (action === 'Switch to Local') {
            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(localPath), { forceNewWindow: false });
        }
    }

    /**
     * Auto-start the local linkspan for the current workspace on extension activation.
     * Retries with exponential backoff on failure.
     */
    private async _autoStartLinkspan(attempt = 0): Promise<void> {
        const MAX_RETRIES = 3;
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            return;
        }
        // Show starting state on the card
        this.ctx.linkspanStartingPath = workspacePath;
        this.refreshSessionsView();
        try {
            await ensureLocalLinkspan(this.ctx);
            const localSession = allRuntimes(this.ctx.workspaces).find(r => r.isLocal && r.status === 'Local');
            const tunnelName = localSession ? `ls-local-${localSession.id}` : undefined;
            // Pre-delete stale tunnel so linkspan creates a fresh one
            if (tunnelName) { this._deleteDevTunnel(tunnelName); }
            await this.ctx.localLinkspan.ensure(workspacePath, tunnelName);
            this.ctx.outputChannel.appendLine('[linkspan-local] Auto-started successfully');
            this._sendRuntimeUpdates();
            // Announce the new local linkspan to any active remote sessions
            await this._reconnectActiveSessions(workspacePath);
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[linkspan-local] Auto-start failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}`);
            if (attempt < MAX_RETRIES) {
                const delay = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
                setTimeout(() => this._autoStartLinkspan(attempt + 1), delay);
            }
        } finally {
            this.ctx.linkspanStartingPath = undefined;
            this.refreshSessionsView();
        }
    }

    async startLocalLinkspan(): Promise<void> {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        // Immediate UI feedback — mark as starting
        this.ctx.linkspanStartingPath = workspacePath;
        this.refreshSessionsView();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting Linkspan',
            cancellable: false,
        }, async (progress) => {
            try {
                progress.report({ message: 'Downloading latest linkspan...' });
                await ensureLocalLinkspan(this.ctx);
                progress.report({ message: 'Starting...' });
                const localSession = allRuntimes(this.ctx.workspaces).find(r => r.isLocal && r.status === 'Local');
                const tunnelName = localSession ? `ls-local-${localSession.id}` : undefined;
                if (tunnelName) { this._deleteDevTunnel(tunnelName); }
                await this.ctx.localLinkspan.ensure(workspacePath, tunnelName);
                const info = this.ctx.localLinkspan.get(workspacePath);
                if (info) {
                    this.ctx.outputChannel.appendLine(`[linkspan-local] Started: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}`);
                }
                vscode.window.showInformationMessage('Linkspan started');
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[linkspan-local] Start failed: ${err.message}`);
                vscode.window.showErrorMessage(`Linkspan start failed: ${err.message}`);
            } finally {
                this.ctx.linkspanStartingPath = undefined;
                this.refreshSessionsView();
            }
        });
        // Reconnect any active sessions through the new linkspan
        await this._reconnectActiveSessions(workspacePath);
    }

    /**
     * Restart the local linkspan: download latest binary, stop existing, start fresh.
     */
    async restartLocalLinkspan(sessionId?: string): Promise<void> {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        // Immediate UI feedback — mark as restarting
        this.ctx.linkspanStartingPath = workspacePath;
        this.refreshSessionsView();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Restarting Linkspan',
            cancellable: false,
        }, async (progress) => {
            try {
                progress.report({ message: 'Downloading latest linkspan...' });
                await ensureLocalLinkspan(this.ctx);
                progress.report({ message: 'Stopping current instance...' });
                this.ctx.localLinkspan.stop(workspacePath);
                progress.report({ message: 'Starting fresh instance...' });
                const localSession = allRuntimes(this.ctx.workspaces).find(r => r.isLocal && r.status === 'Local');
                const tunnelName = localSession ? `ls-local-${localSession.id}` : undefined;
                if (tunnelName) { this._deleteDevTunnel(tunnelName); }
                await this.ctx.localLinkspan.ensure(workspacePath, tunnelName);
                const info = this.ctx.localLinkspan.get(workspacePath);
                if (info) {
                    this.ctx.outputChannel.appendLine(`[linkspan-local] Restarted: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}`);
                }
                vscode.window.showInformationMessage('Linkspan restarted with latest version');
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[linkspan-local] Restart failed: ${err.message}`);
                vscode.window.showErrorMessage(`Linkspan restart failed: ${err.message}`);
            } finally {
                this.ctx.linkspanStartingPath = undefined;
                this.refreshSessionsView();
            }
        });
        // Reconnect any active sessions through the new linkspan
        await this._reconnectActiveSessions(workspacePath);
    }

    /**
     * After linkspan starts or restarts, clear stale tunnel connections on all
     * active sessions and re-establish them through the new linkspan instance.
     * Also announces the new local linkspan's tunnel to each remote linkspan
     * so they can reconnect back (for FUSE/storage overlay).
     */
    private async _reconnectActiveSessions(workspacePath: string): Promise<void> {
        const info = this.ctx.localLinkspan.get(workspacePath);
        if (!info) {
            this.ctx.outputChannel.appendLine(`[linkspan-local] _reconnectActiveSessions: no local linkspan info for ${workspacePath}`);
            return;
        }
        const allRemote = allRuntimes(this.ctx.workspaces).filter(rt => !rt.isLocal);
        this.ctx.outputChannel.appendLine(`[linkspan-local] _reconnectActiveSessions: ${allRemote.length} remote session(s), checking for workspace=${workspacePath}`);
        for (const rt of allRemote) {
            this.ctx.outputChannel.appendLine(`[linkspan-local]   session ${rt.id}: status=${rt.status}, localWorkdir=${rt.localWorkdir}, hasTunnelId=${!!rt.tunnelId}, hasTunnelToken=${!!rt.tunnelToken}`);
        }
        const activeSessions = allRemote.filter(
            rt => rt.localWorkdir === workspacePath && rt.status === 'Active' && rt.tunnelId && rt.tunnelToken
        );
        if (activeSessions.length === 0) {
            this.ctx.outputChannel.appendLine(`[linkspan-local] _reconnectActiveSessions: no matching active sessions`);
            return;
        }
        this.ctx.outputChannel.appendLine(`[linkspan-local] Reconnecting ${activeSessions.length} active session(s) through new linkspan`);
        for (const session of activeSessions) {
            // Clear old connection state — the old linkspan instance is gone
            session.connectionId = undefined;
            session._portMap = undefined;
            session.sshTunnelLocalPort = undefined;
        }

        // Tell each remote linkspan to reconnect to the new local tunnel.
        // Strategy: SSH into the remote host and call the remote linkspan's
        // local REST API with curl. Falls back to tunnel URL announce.
        for (const session of activeSessions) {
            const provider = 'devtunnel';  // TODO: get from session when multi-provider
            let reconnected = false;

            // Primary: SSH + curl to remote linkspan's local API
            if (session.remoteServerPort && session.computeNode) {
                try {
                    const payload = JSON.stringify({
                        provider,
                        tunnelId: info.tunnelId,
                        token: info.tunnelToken,
                    });
                    // Run curl on the compute node (linkspan listens on localhost)
                    const curlCmd = `curl -sf -X POST http://127.0.0.1:${session.remoteServerPort}/api/v1/tunnels/connect -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'`;
                    const sshTarget = session.computeNode || session.host;
                    const result = await this.ctx.ssh.runRemoteCommand(sshTarget, curlCmd);
                    if (result.code === 0) {
                        this.ctx.outputChannel.appendLine(`[linkspan-local] Reconnected remote ${session.id} to new local tunnel via SSH+curl`);
                        reconnected = true;
                    } else {
                        this.ctx.outputChannel.appendLine(`[linkspan-local] SSH+curl reconnect failed for ${session.id}: ${result.stdout}`);
                    }
                } catch (err: any) {
                    this.ctx.outputChannel.appendLine(`[linkspan-local] SSH+curl error for ${session.id}: ${err.message}`);
                }
            }

            // Fallback: try announce via tunnel URL
            if (!reconnected) {
                try {
                    await this._announceLocalLinkspan(session, info);
                } catch (err: any) {
                    this.ctx.outputChannel.appendLine(`[linkspan-local] Announce error for ${session.id}: ${err.message}`);
                }
            }

            // Verify session is still alive
            try {
                await this._checkJobViaSsh(session);
                this.ctx.outputChannel.appendLine(`[linkspan-local] Remote ${session.id} job status: ${session.status}`);
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[linkspan-local] SSH check failed for ${session.id}: ${err.message}`);
            }
        }

        saveSessions(this.ctx);
        this._sendRuntimeUpdates();
    }

    /**
     * Announce the local linkspan's tunnel info to a remote linkspan via its
     * metadata API. This allows the remote linkspan to reconnect back to the
     * new local instance (e.g. for FUSE overlay, storage sync).
     */
    private async _announceLocalLinkspan(session: Runtime, localInfo: import('./LocalLinkspan.js').LocalLinkspanInfo): Promise<void> {
        if (!session.tunnelUrl || !session.tunnelToken) { return; }
        const baseUrl = session.tunnelUrl.replace(/\/$/, '');
        const payload = {
            tunnelId: localInfo.tunnelId,
            tunnelToken: localInfo.tunnelToken,
            tunnelUrl: localInfo.tunnelUrl,
            sshPort: localInfo.sshPort,
            workspacePath: localInfo.workspacePath,
        };
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            const resp = await fetch(`${baseUrl}/api/v1/metadata/local_linkspan`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    ...(session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {}),
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (resp.ok) {
                this.ctx.outputChannel.appendLine(`[linkspan-local] Announced local linkspan to remote ${session.id} (${session.host})`);
            } else {
                this.ctx.outputChannel.appendLine(`[linkspan-local] Announce failed for ${session.id}: ${resp.status} ${await resp.text()}`);
            }
        } catch (err: any) {
            this.ctx.outputChannel.appendLine(`[linkspan-local] Announce failed for ${session.id}: ${err.message}`);
        }
    }

    /**
     * Delete a devtunnel by name (best-effort, synchronous).
     * Used to pre-cleanup stale tunnels before creating new ones.
     */
    private _deleteDevTunnel(tunnelName: string): void {
        const devtunnelBin = this.ctx.tunnelManager.resolveDevTunnelBin();
        if (!devtunnelBin) { return; }
        try {
            const result = spawnSync(devtunnelBin, ['delete', tunnelName, '-f'], {
                encoding: 'utf-8',
                timeout: 10_000,
            });
            if (result.status === 0) {
                this.ctx.outputChannel.appendLine(`[tunnel] Deleted stale tunnel ${tunnelName}`);
            }
        } catch {
            // Best-effort
        }
    }

    /**
     * Stop the local linkspan for the current workspace.
     */
    stopLocalLinkspan(): void {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            return;
        }
        // Clear connection state on all sessions using this linkspan
        for (const session of allRuntimes(this.ctx.workspaces)) {
            if (session.localWorkdir === workspacePath && session.connectionId) {
                session.connectionId = undefined;
                session._portMap = undefined;
            }
        }
        this.ctx.localLinkspan.stop(workspacePath);
        saveSessions(this.ctx);
        this.ctx.outputChannel.appendLine(`[linkspan-local] Stopped for ${workspacePath}`);
        vscode.window.showInformationMessage('Linkspan stopped');
        this._sendRuntimeUpdates();
    }

    /**
     * Reinstall all dependencies: linkspan, devtunnel, mutagen.
     */
    async reinstallDependencies(): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'CyberShuttle: Reinstalling dependencies',
            cancellable: false,
        }, async (progress) => {
            const binDir = path.join(os.homedir(), '.cybershuttle', 'bin');
            const results: string[] = [];
            // 1. Linkspan
            progress.report({ message: 'Downloading linkspan...' });
            try {
                const binPath = path.join(binDir, 'linkspan');
                if (fs.existsSync(binPath)) {
                    fs.unlinkSync(binPath);
                }
                await ensureLocalLinkspan(this.ctx);
                results.push('linkspan: OK');
            } catch (err: any) {
                results.push(`linkspan: FAILED (${err.message})`);
            }
            // 2. devtunnel
            progress.report({ message: 'Downloading devtunnel...' });
            try {
                const binPath = path.join(binDir, 'devtunnel');
                if (fs.existsSync(binPath)) {
                    fs.unlinkSync(binPath);
                }
                await this.ctx.tunnelManager.ensureDevTunnel();
                results.push('devtunnel: OK');
            } catch (err: any) {
                results.push(`devtunnel: FAILED (${err.message})`);
            }
            // 3. mutagen
            progress.report({ message: 'Downloading mutagen...' });
            try {
                const binPath = path.join(binDir, 'mutagen');
                if (fs.existsSync(binPath)) {
                    fs.unlinkSync(binPath);
                }
                // Also remove agents tarball
                const agentsPath = path.join(binDir, 'mutagen-agents.tar.gz');
                if (fs.existsSync(agentsPath)) {
                    fs.unlinkSync(agentsPath);
                }
                await this.ctx.dataCache.ensureMutagen();
                results.push('mutagen: OK');
            } catch (err: any) {
                results.push(`mutagen: FAILED (${err.message})`);
            }
            const allOk = results.every(r => r.includes('OK'));
            const msg = `Dependencies: ${results.join(', ')}`;
            if (allOk) {
                vscode.window.showInformationMessage(msg);
            } else {
                vscode.window.showWarningMessage(msg);
            }
            this.ctx.outputChannel.appendLine(`[deps] ${msg}`);
        });
    }


    /**
     * Refresh the Sessions webview content.
     */
    refreshSessionsView() {
        if (this.ctx.disposing) { return; }
        if (this._sessionsView) {
            try {
                this._sessionsView.webview.html = getSessionsHtml(this._sessionsView.webview, this._extensionUri, this.ctx.workspaces, this.ctx.windowId);
                // Runtime updates sent when webview JS signals 'webviewReady'
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[webview] Failed to render sessions: ${err.message}`);
            }
        }
    }

    /**
     * Refresh the Storages webview content.
     */
    refreshStorages() {
        if (this._storagesView) {
            try {
                this._storagesView.webview.html = getStoragesHtml(this._storagesView.webview, this._extensionUri, this.ctx.storageBrowser);
            } catch (err: any) {
                this.ctx.outputChannel.appendLine(`[webview] Failed to render storages: ${err.message}`);
            }
        }
    }

    /**
     * Send incremental runtime status updates to the workspaces webview
     * without replacing the entire HTML. Preserves host picker state,
     * form values, and scroll position.
     */
    private _sendRuntimeUpdates() {
        if (this.ctx.disposing) { return; }
        const activeSession = detectActiveSession(this.ctx.workspaces, this.ctx.windowId);
        const visibleWorkspaces = getVisibleWorkspaces(this.ctx.workspaces, activeSession);
        const updates = visibleWorkspaces.map(ws => ({
            workspaceId: ws.id,
            workspacePath: ws.directoryPath,
            runtimes: ws.runtimes.map(rt => {
                // Attach local linkspan info for Local sessions
                let linkspanInfo: {
                    serverPort: number;
                    sshPort: number;
                    logPort: number;
                    pid: number;
                    tunnelId: string;
                    tunnelUrl: string;
                    tunnelToken: string;
                } | undefined;
                if (rt.status === 'Local' && ws.directoryPath) {
                    const info = this.ctx.localLinkspan.get(ws.directoryPath);
                    if (info) {
                        linkspanInfo = {
                            serverPort: info.serverPort,
                            sshPort: info.sshPort,
                            logPort: info.logPort,
                            pid: info.pid,
                            tunnelId: info.tunnelId,
                            tunnelUrl: info.tunnelUrl,
                            tunnelToken: info.tunnelToken,
                        };
                    }
                }
                // Detect if linkspan is currently starting for this workspace
                const linkspanStarting = rt.status === 'Local' && ws.directoryPath
                    ? this.ctx.linkspanStartingPath === ws.directoryPath
                    : false;

                return {
                    id: rt.id,
                    status: rt.status,
                    host: rt.host,
                    isLocal: !!rt.isLocal,
                    windowId: rt.windowId,
                    isActiveInThisWindow: activeSession?.id === rt.id,
                    isThisWindow: rt.status === 'Local' && rt.windowId === this.ctx.windowId,
                    hasActiveWindow: !!rt.windowId,
                    cpus: rt.cpus,
                    memory: rt.memory,
                    gpu: rt.gpu,
                    wallTime: rt.wallTime,
                    queue: rt.queue,
                    allocation: rt.allocation,
                    tunnelUrl: rt.tunnelUrl,
                    tunnelId: rt.tunnelId,
                    slurmJobId: rt.slurmJobId,
                    errorMessage: rt.errorMessage,
                    submittedAt: rt.submittedAt,
                    connectedRemotePath: rt.connectedRemotePath,
                    localWorkdir: rt.localWorkdir,
                    switching: rt.id === this.ctx.switchingSessionId || !!rt.switchOnReady,
                    linkspanInfo,
                    linkspanStarting,
                };
            }),
        }));
        // Check if any workspace has a running linkspan
        const linkspanRunning = visibleWorkspaces.some(ws => ws.directoryPath && !!this.ctx.localLinkspan.get(ws.directoryPath));
        this._postSessionsMessage({ type: 'updateRuntimes', updates, isRemoteWindow: this.isRemoteWindow, linkspanRunning });
    }

    /**
     * Refresh both webviews.
     */
    public refresh() {
        this._pruneStaleWindows();
        this.refreshSessionsView();
        this.refreshStorages();
        this._updateStatusBar();
    }

    /**
     * Send a message to the Sessions webview.
     */
    private _postSessionsMessage(message: unknown) {
        if (this._sessionsView) {
            this._sessionsView.webview.postMessage(message);
        }
    }

    /**
     * Send a message to the Storages webview.
     */
    private _postStoragesMessage(message: unknown) {
        if (this._storagesView) {
            this._storagesView.webview.postMessage(message);
        }
    }

    private _updateStatusBar() {
        const session = detectActiveSession(this.ctx.workspaces, this.ctx.windowId);
        if (!session || session.status === 'Local' || session.status !== 'Active') {
            this.ctx.statusBarItem.hide();
            if (this.ctx.countdownTimer) {
                clearInterval(this.ctx.countdownTimer);
                this.ctx.countdownTimer = undefined;
            }
            return;
        }

        const updateText = () => {
            const wtParts = session.wallTime.split(':').map(Number);
            const wtTotalMs = ((wtParts[0] || 0) * 60 + (wtParts[1] || 0)) * 60000;
            const deadlineMs = new Date(session.submittedAt).getTime() + wtTotalMs;
            const remaining = deadlineMs - Date.now();

            const gpu = session.gpu !== 'None' ? ` | GPU: ${session.gpu}` : '';
            const meta = `${session.cpus} vCPU | ${session.memory}${gpu} | ${session.queue}`;

            if (remaining <= 0) {
                this.ctx.statusBarItem.text = `$(warning) ${session.host} — expired | ${meta}`;
                this.ctx.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            } else {
                const totalSec = Math.floor(remaining / 1000);
                const hrs = Math.floor(totalSec / 3600);
                const mins = Math.floor((totalSec % 3600) / 60);
                const secs = totalSec % 60;
                const pad = (n: number) => String(n).padStart(2, '0');
                const countdown = hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
                this.ctx.statusBarItem.text = `$(remote) ${session.host} — ${countdown} remaining | ${meta}`;
                const totalMin = totalSec / 60;
                if (totalMin <= 5) {
                    this.ctx.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                } else if (totalMin <= 15) {
                    this.ctx.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                } else {
                    this.ctx.statusBarItem.backgroundColor = undefined;
                }
            }
            this.ctx.statusBarItem.tooltip = `CyberShuttle session on ${session.host}\nJob: ${session.slurmJobId || 'local'}\nResources: ${session.cpus} vCPU, ${session.memory}${gpu}\nQueue: ${session.queue} | Allocation: ${session.allocation}`;
            this.ctx.statusBarItem.show();
        };

        updateText();
        if (this.ctx.countdownTimer) { clearInterval(this.ctx.countdownTimer); }
        this.ctx.countdownTimer = setInterval(updateText, 1000);
    }
}

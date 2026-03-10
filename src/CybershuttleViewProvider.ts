import * as vscode from 'vscode';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, execSync, ChildProcess } from 'child_process';
import { MetricsCollector } from './instrumentation/index.js';
import { SshManager } from './SshManager.js';
import { TunnelManager, TunnelCredentials } from './TunnelManager.js';
import { StorageBrowserManager } from './StorageBrowserManager.js';
import { DataCache } from './vfs/DataCache.js';
import { SyncProvider } from './vfs/SyncProvider.js';
import { MountProvider } from './vfs/MountProvider.js';
import { LocalLinkspanManager, type LocalLinkspanInfo } from './LocalLinkspan.js';

/**
 * Generate the linkspan workflow YAML for a given tunnel name.
 * Uses provider-agnostic tunnel.create / tunnel.connect actions.
 */
function generateLinkspanWorkflow(tunnelName: string, provider: string, serverUrl?: string): string {
    const serverUrlLine = serverUrl ? `\n      server_url: "${serverUrl}"` : '';
    return [
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
    ].join('\n');
}


interface PersistentShell {
    process: ChildProcess;
    host: string;
    ready: Promise<void>;
    pending?: {
        resolve: (result: { stdout: string; code: number }) => void;
        reject: (err: Error) => void;
        marker: string;
        stdout: string;
        gotExit: boolean;
        exitCode: number;
        gotEnd: boolean;
    };
}

interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
}

interface Runtime {
    id: string;
    host: string;
    cpus: string;
    memory: string;
    gpu: string;
    wallTime: string;
    queue: string;
    allocation: string;
    status: 'Local' | 'Pending' | 'Active' | 'Submitting' | 'Deploying agent' | 'Stopping' | 'Failed' | 'Completed' | 'Idle';
    switchOnReady?: boolean;
    submittedAt: Date;
    type: 'local' | 'remote';
    // Window registration fields
    windowId?: string;        // Stable per-window identifier (persisted in globalState)
    heartbeat?: number;       // Unix timestamp of last heartbeat
    slurmJobId?: string;
    script?: string;
    errorMessage?: string;
    isLocal?: boolean;
    localPid?: number;
    tunnelUrl?: string;
    tunnelToken?: string;
    tunnelId?: string;
    sshPort?: number;
    connectedRemotePath?: string;
    localWorkspaceFolder?: string;
    localWorkdir?: string;
    computeNode?: string;
    // FUSE mount fields (still referenced in cleanup paths)
    fuseMountPid?: number;
    localMountPath?: string;
    remoteMountPath?: string;
    localFuseTunnelUrl?: string;
    remoteFusePort?: number;
    fuseTunnelPid?: number;
    localFuseServerPid?: number;
    localFuseTunnelId?: string;
    localFuseConnectToken?: string;
    localFusePort?: number;
    // Tunnel connection state (ephemeral / Tier 3 — not persisted)
    connectionId?: string;
    _portMap?: Map<number, number>; // transient: remotePort → localPort
    // SSH tunnel to compute node (for remote switch)
    sshTunnelPid?: number;
    sshTunnelLocalPort?: number;
    /** @deprecated — old devtunnel CLI connect PID */
    devtunnelConnectPid?: number;
    /** @deprecated — old devtunnel CLI port map */
    _devtunnelPortMap?: Map<number, number>;
    noSlurm?: boolean;
    // Log port from linkspan workflow
    logPort?: number;
    // Sync progress for VFS sync-back
    syncProgress?: { transferred: number; total: number };
    // Timestamp when session entered a terminal state
    terminatedAt?: number;
}

interface Workspace {
    id: string;
    directoryPath: string;
    directoryName: string;
    runtimes: Runtime[];
}


export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly sessionsViewType = 'cybershuttle.sessionsView';
    public static readonly storagesViewType = 'cybershuttle.storagesView';

    private _sessionsView?: vscode.WebviewView;
    private _storagesView?: vscode.WebviewView;
    private _outputChannel: vscode.OutputChannel;
    private _sshControlDir: string;
    private _workspaces: Workspace[] = [];
    private _workspaceState: vscode.Memento;
    private _logTailProcesses: Map<string, ChildProcess> = new Map();
    private _associationsCts: Map<string, vscode.CancellationTokenSource> = new Map();
    private _cachedRemoteHome: Map<string, string> = new Map();
    private _localProcesses: Map<string, ChildProcess> = new Map();
    public tunnelManager: TunnelManager;
    private _localLinkspan: LocalLinkspanManager;
    private _linkspanStartingPath: string | undefined;
    private _ssh: SshManager;
    private _storageBrowser: StorageBrowserManager;
    private _dataCache: DataCache;
    private _syncProvider: SyncProvider;
    private _mountProvider: MountProvider;
    private _switchingSessionId?: string;
    private _sessionPollTimer?: ReturnType<typeof setInterval>;
    private _sessionPollBusy = false;
    private _sessionsFilePath: string;
    private _lastWriteTime: number = 0;
    public readonly isRemoteWindow: boolean;
    private _statusBarItem: vscode.StatusBarItem;
    private _countdownTimer?: ReturnType<typeof setInterval>;
    private _disposing = false;
    private _tearingDown = new Set<string>();
    private _metrics: MetricsCollector;
    private _windowId: string = '';
    private _heartbeatTimer?: ReturnType<typeof setInterval>;
    private _linkspanDownloaded = false;
    /** @deprecated — kept only for old SSH shell methods that haven't been removed yet */
    private _persistentShells: Map<string, PersistentShell> = new Map();

    private static readonly HOST_PREFS_KEY = 'cybershuttle.hostPrefs';
    private static readonly TIER3_FIELDS: (keyof Runtime)[] = [
        'connectionId', '_portMap', 'sshTunnelLocalPort', 'syncProgress',
    ];

    private _allRuntimes(): Runtime[] {
        return this._workspaces.flatMap(ws => ws.runtimes);
    }

    private _findRuntime(runtimeId: string): { workspace: Workspace; runtime: Runtime } | undefined {
        for (const ws of this._workspaces) {
            const rt = ws.runtimes.find(r => r.id === runtimeId);
            if (rt) { return { workspace: ws, runtime: rt }; }
        }
        return undefined;
    }

    private _getOrCreateWorkspace(dirPath: string): Workspace {
        let ws = this._workspaces.find(w => w.directoryPath === dirPath);
        if (!ws) {
            ws = {
                id: crypto.randomBytes(4).toString('hex'),
                directoryPath: dirPath,
                directoryName: dirPath === 'unknown' ? 'No Folder' : (path.basename(dirPath) || dirPath),
                runtimes: [],
            };
            this._workspaces.push(ws);
        }
        return ws;
    }

    constructor(private readonly _extensionUri: vscode.Uri, workspaceState: vscode.Memento, metrics: MetricsCollector) {
        this._metrics = metrics;
        this._workspaceState = workspaceState;
        this._outputChannel = vscode.window.createOutputChannel('CyberShuttle');
        this._ssh = new SshManager(this._extensionUri, this._outputChannel, metrics);
        this.tunnelManager = new TunnelManager(this._outputChannel, metrics);
        this.tunnelManager.onAuthStateChanged = (account) => this.postAuthState(account);
        this._storageBrowser = new StorageBrowserManager(this._ssh, (msg: unknown) => this._postStoragesMessage(msg));
        this._dataCache = new DataCache(this._outputChannel);
        this._syncProvider = new SyncProvider(this._dataCache, this._outputChannel);
        this._mountProvider = new MountProvider(this._dataCache, this._outputChannel);
        this._localLinkspan = new LocalLinkspanManager(
            this._outputChannel,
            () => this.ensureLocalLinkspan(),
            () => this.tunnelManager.getCredentials(),
        );
        // Kill any stale linkspan processes from previous sessions
        this._localLinkspan.killStaleProcesses();
        // Short path to stay under macOS 104-byte Unix socket limit
        this._sshControlDir = path.join(os.homedir(), '.cs-ssh');
        if (!fs.existsSync(this._sshControlDir)) {
            fs.mkdirSync(this._sshControlDir, { mode: 0o700 });
        }
        // File-based session storage for cross-window sync
        const csDir = path.join(os.homedir(), '.cybershuttle');
        if (!fs.existsSync(csDir)) {
            fs.mkdirSync(csDir, { mode: 0o700 });
        }
        this._sessionsFilePath = path.join(csDir, 'sessions.json');
        // Detect if this window is a Remote-SSH window
        const folder = vscode.workspace.workspaceFolders?.[0];
        this.isRemoteWindow = folder?.uri.scheme === 'vscode-remote';
        // Status bar item for active session countdown
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this._loadSessions();
        this._watchSessionsFile();
        this._updateStatusBar();

        // Generate or retrieve a stable window ID for this VS Code window
        this._windowId = this._workspaceState.get<string>('cybershuttle.windowId') || crypto.randomBytes(8).toString('hex');
        this._workspaceState.update('cybershuttle.windowId', this._windowId);

        // Auto-register this window as a Local session
        this._registerWindow();


        // Heartbeat every 30s to keep this window's session alive
        this._heartbeatTimer = setInterval(() => this._heartbeat(), 30_000);

        // When workspace folder changes, re-register to fix 'unknown' workspace names
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this._registerWindow();
            this.refresh();
        });
    }

    private _loadSessions() {
        let rawData: any = null;
        // Try to load from shared file first
        try {
            if (fs.existsSync(this._sessionsFilePath)) {
                const content = fs.readFileSync(this._sessionsFilePath, 'utf-8');
                rawData = JSON.parse(content);
            }
        } catch {
            rawData = null;
        }

        if (Array.isArray(rawData) && rawData.length > 0 && rawData[0].runtimes !== undefined) {
            const validStatuses = new Set(['Local', 'Pending', 'Active', 'Submitting', 'Deploying agent', 'Stopping', 'Failed', 'Completed', 'Idle']);
            this._workspaces = rawData
                .filter((ws: any) => {
                    if (!ws || typeof ws.id !== 'string' || typeof ws.directoryPath !== 'string' || !Array.isArray(ws.runtimes)) {
                        this._metrics.record('session_corrupted', 'failure', { reason: 'missing_fields', raw: JSON.stringify(ws).slice(0, 200) });
                        this._outputChannel.appendLine(`[sessions] Removed corrupted workspace: ${JSON.stringify(ws).slice(0, 200)}`);
                        return false;
                    }
                    return true;
                })
                .map((ws: any) => {
                    const validRuntimes = (ws.runtimes || []).filter((r: any) => {
                        if (!r || typeof r.id !== 'string' || typeof r.host !== 'string' || !validStatuses.has(r.status)) {
                            this._metrics.record('session_corrupted', 'failure', { reason: 'missing_fields', workspace: ws.id, raw: JSON.stringify(r).slice(0, 200) });
                            this._outputChannel.appendLine(`[sessions] Removed corrupted session: ${JSON.stringify(r).slice(0, 200)}`);
                            return false;
                        }
                        if (r.status !== 'Local' && !r.isLocal && (!r.wallTime || !r.queue || !r.allocation)) {
                            this._metrics.record('session_corrupted', 'failure', { reason: 'missing_remote_fields', workspace: ws.id, session: r.id });
                            this._outputChannel.appendLine(`[sessions] Removed corrupted remote session ${r.id}: missing wallTime/queue/allocation`);
                            return false;
                        }
                        return true;
                    });
                    return {
                        ...ws,
                        directoryName: ws.directoryPath === 'unknown' ? 'No Folder' : (ws.directoryName || path.basename(ws.directoryPath) || ws.directoryPath),
                        runtimes: validRuntimes.map((r: any) => ({
                            ...r,
                            submittedAt: new Date(r.submittedAt),
                        })),
                    };
                })
                .filter((ws: any) => ws.runtimes.length > 0);
            // Save cleaned data if any corrupted entries were removed
            if (this._workspaces.length !== rawData.length || this._workspaces.some((ws: Workspace, i: number) => ws.runtimes.length !== (rawData[i]?.runtimes?.length ?? 0))) {
                this._saveSessions();
            }
        } else {
            this._workspaces = [];
        }

        // --- Startup Reconciliation ---
        // 1. Strip ALL Tier 3 fields (processes are dead after extension reload)
        for (const session of this._allRuntimes()) {
            session.connectionId = undefined;
            session._portMap = undefined;
            session.sshTunnelLocalPort = undefined;
            session.syncProgress = undefined;
        }
        // 2. Clean SSH config — remove entries for terminal or nonexistent sessions
        this._reconcileSshConfig();
        // 3. Terminate any stale sync/mount sessions from previous extension runs
        this._syncProvider.cleanStaleSessions();
        this._mountProvider.cleanStaleMounts();
        // 4. Reset non-local sessions without SLURM job ID back to Idle
        for (const session of this._allRuntimes()) {
            if (session.isLocal || session.status === 'Local') { continue; }
            if (!session.slurmJobId && session.status !== 'Idle' && session.status !== 'Failed' && session.status !== 'Completed') {
                session.status = 'Idle';
            }
        }
        // 5. Reconcile local sessions (relaunch if process died)
        for (const session of this._allRuntimes()) {
            if (session.status === 'Local') { continue; }
            if (session.isLocal && session.status === 'Active' && session.localPid) {
                try {
                    process.kill(session.localPid, 0);
                } catch {
                    this._resumeLocalSession(session);
                }
            }
        }
        // 6. Infer expired sessions from walltime
        for (const session of this._allRuntimes()) {
            if (session.isLocal || session.status === 'Failed' || session.status === 'Completed') { continue; }
            if (session.status === 'Active' && session.submittedAt && session.wallTime) {
                const wtParts = session.wallTime.split(':').map(Number);
                const wtTotalMin = (wtParts[0] || 0) * 60 + (wtParts[1] || 0);
                const deadlineMs = new Date(session.submittedAt).getTime() + wtTotalMin * 60000;
                if (Date.now() >= deadlineMs) {
                    session.status = 'Completed';
                    this._clearSessionFields(session);
                }
            }
        }
        // 7. Prune terminal sessions older than 24 hours
        const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();
        let pruned = false;
        for (const ws of this._workspaces) {
            const before = ws.runtimes.length;
            ws.runtimes = ws.runtimes.filter(r => {
                if ((r.status === 'Completed' || r.status === 'Failed') && r.terminatedAt) {
                    if (now - r.terminatedAt > TERMINAL_TTL_MS) {
                        this._outputChannel.appendLine(`[sessions] Pruning stale terminal session ${r.id} (terminated ${new Date(r.terminatedAt).toISOString()})`);
                        return false;
                    }
                }
                return true;
            });
            if (ws.runtimes.length !== before) { pruned = true; }
        }
        if (pruned) {
            this._workspaces = this._workspaces.filter(ws => ws.runtimes.length > 0);
            this._saveSessions();
        }

        // Don't auto-resume polling on webview resolve — polling is only
        // started when a job is actively submitted via the UI.
    }

    private _reconcileSshConfig(): void {
        const configPath = this._internalSshConfigPath;
        try {
            if (!fs.existsSync(configPath)) { return; }
            let content = fs.readFileSync(configPath, 'utf-8');
            const allIds = new Set(this._allRuntimes().map(r => r.id));
            const terminalIds = new Set(this._allRuntimes()
                .filter(r => r.status === 'Completed' || r.status === 'Failed' || r.status === 'Idle')
                .map(r => r.id));
            const entryRe = /\n?# CS-Bridge auto-generated for session ([a-f0-9]+)\nHost [^\n]+\n(?:    [^\n]+\n)*/g;
            content = content.replace(entryRe, (match: string, sessionId: string) => {
                if (!allIds.has(sessionId) || terminalIds.has(sessionId)) {
                    this._outputChannel.appendLine(`[ssh-config] Removed stale entry for session ${sessionId}`);
                    return '';
                }
                return match;
            });
            fs.writeFileSync(configPath, content);
        } catch (err: any) {
            this._outputChannel.appendLine(`[ssh-config] Failed to reconcile: ${err.message}`);
        }
    }

    private _getHostPrefs(host: string): { allocation?: string; partition?: string } {
        const all = this._workspaceState.get<Record<string, { allocation?: string; partition?: string }>>(CybershuttleViewProvider.HOST_PREFS_KEY, {});
        return all[host] || {};
    }

    private _saveHostPrefs(host: string, prefs: { allocation?: string; partition?: string }) {
        const all = this._workspaceState.get<Record<string, { allocation?: string; partition?: string }>>(CybershuttleViewProvider.HOST_PREFS_KEY, {});
        all[host] = prefs;
        this._workspaceState.update(CybershuttleViewProvider.HOST_PREFS_KEY, all);
    }

    private _saveSessions() {
        try {
            // Stamp terminatedAt on any terminal session that doesn't have one yet
            for (const r of this._allRuntimes()) {
                if ((r.status === 'Completed' || r.status === 'Failed') && !r.terminatedAt) {
                    r.terminatedAt = Date.now();
                }
            }
            // Deep-clone workspaces and strip Tier 3 (ephemeral) fields before persisting
            const cleaned = this._workspaces.map(ws => ({
                ...ws,
                runtimes: ws.runtimes.map(r => {
                    const copy: any = { ...r };
                    for (const key of CybershuttleViewProvider.TIER3_FIELDS) {
                        delete copy[key];
                    }
                    return copy;
                }),
            }));
            const tmpPath = this._sessionsFilePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2));
            fs.renameSync(tmpPath, this._sessionsFilePath);
            this._lastWriteTime = Date.now();
        } catch (err: any) {
            this._outputChannel.appendLine(`[sessions] Failed to save sessions file: ${err.message}`);
        }
    }

    private _watchSessionsFile() {
        fs.watchFile(this._sessionsFilePath, { interval: 1000 }, () => {
            // Skip reload if this window was the last writer (within 2s window)
            if (Date.now() - this._lastWriteTime < 2000) {
                return;
            }
            this._outputChannel.appendLine('[sessions] Sessions file changed externally, merging');
            this._mergeSessionsFromFile();
            this._sendRuntimeUpdates();
            this._updateStatusBar();
        });
    }

    /**
     * Merge sessions from disk into the in-memory state without destroying
     * ephemeral Tier 3 fields (connectionId, _portMap, etc.).
     * New workspaces/sessions from other windows are added; existing sessions
     * get their persisted fields updated but keep their live tunnel state.
     */
    private _mergeSessionsFromFile() {
        let rawData: any;
        try {
            if (fs.existsSync(this._sessionsFilePath)) {
                rawData = JSON.parse(fs.readFileSync(this._sessionsFilePath, 'utf-8'));
            }
        } catch { return; }
        if (!Array.isArray(rawData)) { return; }

        // Build lookup of existing in-memory sessions by ID
        const existingById = new Map<string, Runtime>();
        for (const rt of this._allRuntimes()) {
            existingById.set(rt.id, rt);
        }
        const existingWsById = new Map<string, Workspace>();
        for (const ws of this._workspaces) {
            existingWsById.set(ws.id, ws);
        }

        for (const wsData of rawData) {
            if (!wsData?.id || !Array.isArray(wsData.runtimes)) { continue; }
            const existingWs = existingWsById.get(wsData.id);
            if (!existingWs) {
                // New workspace from another window — add it
                this._workspaces.push({
                    id: wsData.id,
                    directoryPath: wsData.directoryPath,
                    directoryName: wsData.directoryName || path.basename(wsData.directoryPath) || wsData.directoryPath,
                    runtimes: wsData.runtimes.map((r: any) => ({
                        ...r,
                        submittedAt: new Date(r.submittedAt),
                    })),
                });
                continue;
            }
            for (const rtData of wsData.runtimes) {
                if (!rtData?.id) { continue; }
                const existing = existingById.get(rtData.id);
                if (!existing) {
                    // New session from another window — add it
                    existingWs.runtimes.push({
                        ...rtData,
                        submittedAt: new Date(rtData.submittedAt),
                    });
                } else {
                    // Existing session — update persisted fields, preserve Tier 3
                    const saved: Record<string, any> = {};
                    for (const key of CybershuttleViewProvider.TIER3_FIELDS) {
                        saved[key] = (existing as any)[key];
                    }
                    Object.assign(existing, rtData, { submittedAt: new Date(rtData.submittedAt) });
                    for (const key of CybershuttleViewProvider.TIER3_FIELDS) {
                        (existing as any)[key] = saved[key];
                    }
                }
            }
            // Remove sessions that are no longer in the file (deleted by another window)
            const fileIds = new Set(wsData.runtimes.map((r: any) => r.id));
            existingWs.runtimes = existingWs.runtimes.filter(r => fileIds.has(r.id));
        }
        // Remove workspaces that are no longer in the file
        const fileWsIds = new Set(rawData.map((ws: any) => ws.id));
        this._workspaces = this._workspaces.filter(ws => fileWsIds.has(ws.id));
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
                for (const w of this._workspaces) {
                    const rt = w.runtimes.find(r => r.id === sessionId);
                    if (rt) {
                        rt.windowId = this._windowId;
                        rt.heartbeat = Date.now();
                        this._saveSessions();
                        return;
                    }
                }
            }
        }

        const dirPath = folder
            ? (folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString())
            : 'unknown';

        let existing: { workspace: Workspace; runtime: Runtime } | undefined;
        for (const w of this._workspaces) {
            const rt = w.runtimes.find(r => r.windowId === this._windowId);
            if (rt) { existing = { workspace: w, runtime: rt }; break; }
        }

        if (existing) {
            existing.runtime.heartbeat = Date.now();
            // If workspace path has changed (or was 'unknown'), move the runtime to the correct workspace
            if (existing.workspace.directoryPath !== dirPath && dirPath !== 'unknown') {
                existing.workspace.runtimes = existing.workspace.runtimes.filter(r => r.windowId !== this._windowId);
                if (existing.workspace.runtimes.length === 0) {
                    this._workspaces = this._workspaces.filter(w => w.id !== existing!.workspace.id);
                }
                const ws = this._getOrCreateWorkspace(dirPath);
                ws.runtimes.push(existing.runtime);
            } else if (dirPath === 'unknown') {
                // Window no longer has a folder open — remove this Local runtime
                existing.workspace.runtimes = existing.workspace.runtimes.filter(r => r.windowId !== this._windowId);
                if (existing.workspace.runtimes.length === 0) {
                    this._workspaces = this._workspaces.filter(w => w.id !== existing!.workspace.id);
                }
            }
            this._saveSessions();
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
            detached.windowId = this._windowId;
            detached.heartbeat = Date.now();
            this._saveSessions();
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
            windowId: this._windowId,
            heartbeat: Date.now(),
        };

        ws.runtimes.push(runtime);
        this._saveSessions();
    }

    /**
     * Update heartbeat timestamp for this window's session.
     */
    private _heartbeat() {
        this._pruneStaleWindows();
        for (const ws of this._workspaces) {
            const runtime = ws.runtimes.find(r => r.windowId === this._windowId);
            if (runtime) {
                runtime.heartbeat = Date.now();
                this._saveSessions();
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
        for (const ws of this._workspaces) {
            for (const s of ws.runtimes) {
                // Mark stale Local runtimes as inactive (closed window)
                if (s.windowId && s.windowId !== this._windowId && s.status === 'Local' && !s.slurmJobId) {
                    if (!s.heartbeat || s.heartbeat <= cutoff) {
                        s.windowId = undefined; // Detach from closed window
                        pruned = true;
                    }
                }
            }
        }
        // Save only if something was actually pruned
        if (pruned) {
            this._saveSessions();
        }
    }

    public dispose() {
        this._disposing = true;
        // Stop timers
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = undefined;
        }
        if (this._countdownTimer) {
            clearInterval(this._countdownTimer);
            this._countdownTimer = undefined;
        }
        this._statusBarItem.dispose();
        this._stopSessionPolling();
        // Stop all local linkspan processes (clean shutdown)
        this._localLinkspan.stopAll();
        fs.unwatchFile(this._sessionsFilePath);
        // Full cleanup for all sessions
        for (const session of this._allRuntimes()) {
            const sessionId = session.id;
            // Terminate VFS synchronously (no await in dispose)
            this._syncProvider.stopSync(session);
            this._mountProvider.stopSync(session);
            // Clear tunnel connection state
            session.connectionId = undefined;
            session._portMap = undefined;
            session.sshTunnelLocalPort = undefined;
            // Remove SSH config entry
            const alias = session.isLocal ? `cs-tunnel-${sessionId}` : `cs-session-${sessionId}`;
            this._removeSshConfigEntry(sessionId, alias);
        }
        // Clean up window registration
        for (const ws of this._workspaces) {
            const myRuntime = ws.runtimes.find(r => r.windowId === this._windowId);
            if (myRuntime) {
                if (myRuntime.status === 'Local') {
                    ws.runtimes = ws.runtimes.filter(r => r.id !== myRuntime.id);
                } else {
                    myRuntime.windowId = undefined;
                }
                break;
            }
        }
        this._workspaces = this._workspaces.filter(ws => ws.runtimes.length > 0);
        // Dispose association cancellation tokens
        for (const [, cts] of this._associationsCts) {
            cts.cancel();
            cts.dispose();
        }
        this._associationsCts.clear();
        // Save cleaned state
        this._saveSessions();
        // Final process cleanup
        this._ssh.disposePersistentShells();
        this.stopAllLogStreams();
        this.stopAllLocalProcesses();
    }

    /**
     * Detect which session (if any) is active in this VS Code window.
     * Checks workspace folder URI for Remote-SSH patterns:
     *   - Local sessions: ssh-remote+cs-tunnel-{id}
     *   - Remote SLURM sessions: ssh-remote+{hostName}
     */
    private _detectActiveSession(): Runtime | undefined {
        // First, try to match by vscode-remote URI (more reliable than windowId for remote windows)
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder?.uri.scheme === 'vscode-remote') {
            const authority = folder.uri.authority;
            const allRuntimes = this._allRuntimes();
            // Local session: ssh-remote+cs-tunnel-{sessionId}
            const localMatch = authority.match(/^ssh-remote\+cs-tunnel-(.+)$/);
            if (localMatch) {
                const sessionId = localMatch[1];
                return allRuntimes.find(s => s.id === sessionId);
            }
            // Remote SLURM session: ssh-remote+cs-session-{sessionId}
            const remoteMatch = authority.match(/^ssh-remote\+cs-session-(.+)$/);
            if (remoteMatch) {
                const sessionId = remoteMatch[1];
                return allRuntimes.find(s => s.id === sessionId);
            }
            // Fallback: match by hostname for remote sessions
            const hostMatch = authority.match(/^ssh-remote\+(.+)$/);
            if (hostMatch) {
                const hostName = hostMatch[1];
                return allRuntimes.find(s => !s.isLocal && s.host === hostName && s.status === 'Active')
                    || allRuntimes.find(s => !s.isLocal && s.host === hostName);
            }
        }

        // Fallback: check if this window has its own registered runtime
        const allRuntimes = this._allRuntimes();
        const mySession = allRuntimes.find(s => s.windowId === this._windowId);
        return mySession;
    }

    /**
     * Determine which workspaces to show in the sidebar.
     * For local windows: match by folder path.
     * For remote windows: find the workspace containing the active session so that
     * session info remains visible after switching to remote.
     */
    private _getVisibleWorkspaces(activeSession: Runtime | undefined): Workspace[] {
        const currentFolder = vscode.workspace.workspaceFolders?.[0];

        // For remote windows, find the workspace containing the active session
        if (currentFolder?.uri.scheme === 'vscode-remote' && activeSession) {
            const ws = this._workspaces.find(w => w.runtimes.some(r => r.id === activeSession.id));
            return ws ? [ws] : [];
        }

        const currentDirPath = currentFolder
            ? (currentFolder.uri.scheme === 'file' ? currentFolder.uri.fsPath : currentFolder.uri.toString())
            : undefined;
        return currentDirPath
            ? this._workspaces.filter(ws => ws.directoryPath === currentDirPath)
            : [];
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
        if (this._sessionPollTimer) {
            return; // already polling
        }
        this._outputChannel.appendLine('[poll] Starting session setup poll (every 5s)');

        const doPoll = async () => {
            if (this._sessionPollBusy) { return; }
            this._sessionPollBusy = true;
            try {
                await this.refreshSessions();
            } finally {
                this._sessionPollBusy = false;
            }
            // Stop polling if no sessions need setup monitoring
            if (!this._allRuntimes().some(s => this._sessionNeedsSetupPolling(s))) {
                this._stopSessionPolling();
            }
        };

        // Fire immediately, then every 5 seconds
        doPoll();
        this._sessionPollTimer = setInterval(doPoll, 5000);
    }

    private _stopSessionPolling() {
        if (this._sessionPollTimer) {
            this._outputChannel.appendLine('[poll] Stopping session auto-poll');
            clearInterval(this._sessionPollTimer);
            this._sessionPollTimer = undefined;
        }
    }

    /**
     * Get or create a persistent SSH shell for a host.
     * The shell stays alive for fast sequential command execution (file browsing).
     */
    private _getOrCreateShell(hostName: string): PersistentShell {
        const existing = this._persistentShells.get(hostName);
        if (existing && !existing.process.killed) {
            return existing;
        }

        const shellConnectStart = Date.now();
        this._metrics.record('ssh_connect', 'in_progress', { target_host: this._resolveHostname(hostName) });
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
        const cancelFile = path.join(sessionDir, 'cancel');
        const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');

        const proc = spawn('ssh', [
            ...this.getControlMasterArgs(hostName),
            '-o', 'NumberOfPasswordPrompts=3',
            '-o', 'ServerAliveInterval=30',
            '-o', 'ServerAliveCountMax=3',
            hostName,
            'sh', // non-interactive shell
        ], {
            env: {
                ...process.env,
                SSH_ASKPASS: askpassScript,
                SSH_ASKPASS_REQUIRE: 'force',
                CS_ASKPASS_DIR: sessionDir,
                DISPLAY: ':0',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Ready resolves once the shell has produced its first prompt marker
        const readyMarker = `__CS_READY_${crypto.randomBytes(4).toString('hex')}__`;
        let resolveReady: () => void;
        const ready = new Promise<void>(r => { resolveReady = r; });

        const shell: PersistentShell = { process: proc, host: hostName, ready };
        this._persistentShells.set(hostName, shell);

        let buffer = '';
        let isReady = false;

        proc.stdout!.on('data', (data: Buffer) => {
            buffer += data.toString();

            // Check for ready marker during initial connect
            if (!isReady) {
                const readyIdx = buffer.indexOf(readyMarker);
                if (readyIdx === -1) { return; }
                isReady = true;
                buffer = buffer.slice(readyIdx + readyMarker.length);
                // Consume trailing newline
                if (buffer.startsWith('\n')) { buffer = buffer.slice(1); }
                resolveReady!();
                this._metrics.record('ssh_connect', 'success', { target_host: this._resolveHostname(hostName) }, Date.now() - shellConnectStart);
            }

            // Process pending command response
            if (shell.pending) {
                const p = shell.pending;
                const exitMarker = `__CS_EXIT_${p.marker}:`;
                const endMarker = `__CS_END_${p.marker}__`;

                // Scan buffer for exit code marker and end marker
                while (buffer.length > 0) {
                    if (!p.gotExit) {
                        const exitIdx = buffer.indexOf(exitMarker);
                        if (exitIdx === -1) {
                            // Accumulate everything before any potential partial marker
                            const safeEnd = buffer.length - (exitMarker.length + 10);
                            if (safeEnd > 0) {
                                p.stdout += buffer.slice(0, safeEnd);
                                buffer = buffer.slice(safeEnd);
                            }
                            break;
                        }
                        p.stdout += buffer.slice(0, exitIdx);
                        const afterExit = buffer.slice(exitIdx + exitMarker.length);
                        const nlIdx = afterExit.indexOf('\n');
                        if (nlIdx === -1) { break; } // exit code line not complete yet
                        p.exitCode = parseInt(afterExit.slice(0, nlIdx), 10) || 0;
                        p.gotExit = true;
                        buffer = afterExit.slice(nlIdx + 1);
                    }

                    if (!p.gotEnd) {
                        const endIdx = buffer.indexOf(endMarker);
                        if (endIdx === -1) { break; }
                        p.gotEnd = true;
                        buffer = buffer.slice(endIdx + endMarker.length);
                        // Consume trailing newline if present
                        if (buffer.startsWith('\n')) { buffer = buffer.slice(1); }
                    }

                    if (p.gotExit && p.gotEnd) {
                        const result = { stdout: p.stdout, code: p.exitCode };
                        shell.pending = undefined;
                        p.resolve(result);
                        break;
                    }
                }
            }
        });

        // Handle askpass prompts (same as runRemoteCommand)
        let disposed = false;
        const handledPrompts = new Set<string>();
        const pollInterval = setInterval(async () => {
            if (disposed) { return; }
            try {
                const files = fs.readdirSync(sessionDir);
                for (const file of files) {
                    if (!file.startsWith('prompt-') || handledPrompts.has(file)) { continue; }
                    handledPrompts.add(file);
                    const promptFilePath = path.join(sessionDir, file);
                    const content = fs.readFileSync(promptFilePath, 'utf-8');
                    const { id, prompt } = JSON.parse(content);
                    const responseFile = path.join(sessionDir, `response-${id}`);
                    const password = await vscode.window.showInputBox({
                        title: `SSH Authentication — ${hostName}`,
                        prompt: prompt.trim(),
                        password: true,
                        ignoreFocusOut: true,
                    });
                    if (password !== undefined) {
                        fs.writeFileSync(responseFile, password, 'utf-8');
                    } else {
                        fs.writeFileSync(cancelFile, '', 'utf-8');
                        proc.kill();
                    }
                }
            } catch { /* ignore */ }
        }, 200);

        proc.on('close', () => {
            disposed = true;
            clearInterval(pollInterval);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this._persistentShells.delete(hostName);
            if (!isReady) {
                this._metrics.record('ssh_connect', 'failure', { target_host: this._resolveHostname(hostName) }, Date.now() - shellConnectStart, 'SSH connection closed before ready');
            }
            if (shell.pending) {
                shell.pending.reject(new Error('SSH connection closed'));
                shell.pending = undefined;
            }
        });

        proc.on('error', (err) => {
            disposed = true;
            clearInterval(pollInterval);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this._persistentShells.delete(hostName);
            if (!isReady) {
                this._metrics.record('ssh_connect', 'failure', { target_host: this._resolveHostname(hostName) }, Date.now() - shellConnectStart, err.message);
            }
            if (shell.pending) {
                shell.pending.reject(err);
                shell.pending = undefined;
            }
        });

        // Send ready probe
        proc.stdin!.write(`echo '${readyMarker}'\n`);

        return shell;
    }

    /**
     * Run a command on a persistent SSH shell. Returns stdout and exit code.
     * Commands are serialized — only one runs at a time per host.
     */
    private async _runShellCommand(hostName: string, command: string): Promise<{ stdout: string; code: number }> {
        const shell = this._getOrCreateShell(hostName);
        await shell.ready;

        if (shell.process.killed) {
            throw new Error('SSH connection closed');
        }

        const marker = crypto.randomBytes(6).toString('hex');

        return new Promise((resolve, reject) => {
            shell.pending = {
                resolve, reject, marker,
                stdout: '', gotExit: false, exitCode: 0, gotEnd: false,
            };

            // Wrap the command: run it, then echo the exit code and end marker
            const wrapped = `${command}\necho "__CS_EXIT_${marker}:$?"\necho "__CS_END_${marker}__"\n`;
            shell.process.stdin!.write(wrapped);
        });
    }

    /**
     * Dispose all persistent SSH shells.
     */
    public disposePersistentShells() {
        for (const [, shell] of this._persistentShells) {
            shell.process.kill();
        }
        this._persistentShells.clear();
    }

    /**
     * Get SSH args for connection multiplexing (ControlMaster).
     * Uses a short hashed socket name to stay under the 104-byte limit.
     */
    private getControlMasterArgs(hostName: string): string[] {
        const hash = crypto.createHash('sha256').update(hostName).digest('hex').substring(0, 16);
        const socketPath = path.join(this._sshControlDir, hash);
        return [
            '-o', `ControlMaster=auto`,
            '-o', `ControlPath=${socketPath}`,
            '-o', `ControlPersist=600`,
        ];
    }

    /**
     * Parse SSH config file and extract host entries
     */
    private getSshHosts(): SshHost[] {
        const hosts: SshHost[] = [];
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');

        try {
            if (!fs.existsSync(sshConfigPath)) {
                return hosts;
            }

            const configContent = fs.readFileSync(sshConfigPath, 'utf-8');
            const lines = configContent.split('\n');

            let currentHost: SshHost | null = null;

            for (const line of lines) {
                const trimmed = line.trim();
                
                // Skip comments and empty lines
                if (trimmed.startsWith('#') || trimmed === '') {
                    continue;
                }

                const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
                if (hostMatch) {
                    // Save previous host if exists
                    if (currentHost) {
                        hosts.push(currentHost);
                    }
                    // Start new host (skip wildcards)
                    const hostName = hostMatch[1].trim();
                    if (!hostName.includes('*') && !hostName.includes('?')
                        && !hostName.startsWith('cs-session-') && !hostName.startsWith('cs-tunnel-')) {
                        currentHost = { name: hostName };
                    } else {
                        currentHost = null;
                    }
                    continue;
                }

                if (currentHost) {
                    const hostnameMatch = trimmed.match(/^HostName\s+(.+)$/i);
                    if (hostnameMatch) {
                        currentHost.hostname = hostnameMatch[1].trim();
                    }

                    const userMatch = trimmed.match(/^User\s+(.+)$/i);
                    if (userMatch) {
                        currentHost.user = userMatch[1].trim();
                    }
                }
            }

            // Don't forget the last host
            if (currentHost) {
                hosts.push(currentHost);
            }
        } catch (err) {
            console.error('Error reading SSH config:', err);
        }

        return hosts;
    }

    /**
     * Resolve an SSH config alias to its actual HostName.
     * Returns the HostName if found, otherwise returns the alias as-is.
     */
    private _resolveHostname(alias: string): string {
        const hosts = this.getSshHosts();
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
                webviewView.webview.html = this._getSessionsHtml(webviewView.webview);
            } else {
                webviewView.webview.html = this._getStoragesHtml(webviewView.webview);
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`[webview] Failed to render: ${err.message}\n${err.stack}`);
            webviewView.webview.html = `<html><body><p>Failed to load CyberShuttle panel: ${err.message}</p></body></html>`;
        }

        // Check Dev Tunnels auth on startup from the sessions view
        if (isSessions) {
            webviewView.title = 'Sessions';
            this.tunnelManager.checkDevTunnelAuth();
        }

        webviewView.onDidDispose(() => {
            if (isSessions) {
                this._sessionsView = undefined;
                this._ssh.disposePersistentShells();
                this.stopAllLogStreams();
                this._stopSessionPolling();
            } else {
                this._storagesView = undefined;
            }
        });

        // Route messages from all views into the same handler
        webviewView.webview.onDidReceiveMessage((data) => this._onMessage(data));

        // Immediately push real data to replace loading skeletons
        if (isSessions) {
            this._sendRuntimeUpdates();
        }
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
            case 'switchToWindow': {
                this.switchToWindow(data.sessionId);
                break;
            }
            case 'storagesBrowseDir': {
                this._storageBrowser.navigateTo(data.host, data.path);
                this.refreshStorages();
                this._storageBrowser.browseCurrent();
                break;
            }
            case 'storagesOpenFile': {
                this._storageBrowser.openRemoteFile(data.host, data.path);
                break;
            }
            case 'storagesGoBack': {
                if (this._storageBrowser.goBack()) {
                    this.refreshStorages();
                    this._storageBrowser.browseCurrent();
                }
                break;
            }
            case 'storagesGoForward': {
                if (this._storageBrowser.goForward()) {
                    this.refreshStorages();
                    this._storageBrowser.browseCurrent();
                }
                break;
            }
            case 'storagesRefresh': {
                this._storageBrowser.browseCurrent();
                break;
            }
            case 'storagesGoHome': {
                this._storageBrowser.goHome();
                this.refreshStorages();
                break;
            }
            case 'addRuntime': {
                const { host, cpus, memory, gpu, wallTime, queue, allocation, workspaceId } = data;
                const sessionId = crypto.randomBytes(4).toString('hex');
                let ws = workspaceId ? this._workspaces.find(w => w.id === workspaceId) : undefined;
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
                    connectedRemotePath: `~/overlay/${sessionId}`,
                };
                ws.runtimes.push(newRuntime);
                // Save last-used allocation/partition per host
                this._saveHostPrefs(host, { allocation, partition: queue });
                this._saveSessions();
                this.refreshSessionsView();
                break;
            }
            case 'queryAssociations': {
                this.queryAssociations(data.host);
                break;
            }
            case 'relaunchSession': {
                this.relaunchSession(data.sessionId);
                break;
            }
            case 'closeSession': {
                const found = this._findRuntime(data.sessionId);
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
                                this._ssh.runRemoteCommand(remote.host, `scancel ${remote.slurmJobId}`).catch(() => {});
                            }
                            await this._cleanupSessionConnections(remote, remote.id);
                            this._ssh.killShell(remote.host);
                            const logTail = this._logTailProcesses.get(remote.id);
                            if (logTail) {
                                logTail.kill();
                                this._logTailProcesses.delete(remote.id);
                            }
                        }
                        // Stop and remove the local session + entire workspace
                        await this.stopLocalSession(data.sessionId);
                        this._workspaces = this._workspaces.filter(w => w.id !== found.workspace.id);
                    } else {
                        // Closing a remote session
                        if (rt.slurmJobId && rt.status !== 'Failed' && rt.status !== 'Completed') {
                            this._ssh.runRemoteCommand(rt.host, `scancel ${rt.slurmJobId}`).catch(() => {});
                        }
                        await this._cleanupSessionConnections(rt, rt.id);
                        this._ssh.killShell(rt.host);
                        const logTail = this._logTailProcesses.get(rt.id);
                        if (logTail) {
                            logTail.kill();
                            this._logTailProcesses.delete(rt.id);
                        }
                        found.workspace.runtimes = found.workspace.runtimes.filter(r => r.id !== data.sessionId);
                        if (found.workspace.runtimes.length === 0) {
                            this._workspaces = this._workspaces.filter(w => w.id !== found.workspace.id);
                        }
                    }
                }
                this._saveSessions();
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
     * Add a new SSH host using VS Code Remote-SSH extension
     */
    private async addSshHost() {
        // Try different commands that Remote-SSH extension provides
        try {
            // This command opens the "Add New SSH Host" dialog
            await vscode.commands.executeCommand('opensshremotes.addNewSshHost');
        } catch {
            try {
                // Alternative command
                await vscode.commands.executeCommand('remote-ssh.addNewSshHost');
            } catch {
                // If Remote-SSH commands aren't available, show instructions
                const action = await vscode.window.showWarningMessage(
                    'Remote-SSH extension is required to add SSH hosts. Would you like to install it?',
                    'Install Extension',
                    'Cancel'
                );
                if (action === 'Install Extension') {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode-remote.remote-ssh');
                }
            }
        }
    }

    /**
     * Create a job on a remote SSH host.
     * Generates a SLURM script and sends it to the webview for preview
     * before actual submission.
     */
    private async createJob(hostName: string, cpus: string, memory: string, gpu: string, wallTime: string, queue: string, allocation: string, workspaceId?: string) {
        // Guard: remove any existing unsubmitted session for this host to prevent duplicates
        // (can happen if the user clicks "Submit" while a preview is already showing).
        for (const ws of this._workspaces) {
            ws.runtimes = ws.runtimes.filter(
                s => !(s.host === hostName && s.status === 'Pending' && !s.slurmJobId)
            );
        }
        this._workspaces = this._workspaces.filter(ws => ws.runtimes.length > 0);

        const sessionId = crypto.randomBytes(4).toString('hex');

        let creds: TunnelCredentials;
        try {
            creds = await this.tunnelManager.getCredentials();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
            return;
        }

        const script = this.generateSlurmScript({ cpus, memory, gpu, wallTime, queue, allocation, authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl });

        // Prefer workspace identified by workspaceId (from host picker); fall back to current folder
        let ws = workspaceId ? this._workspaces.find(w => w.id === workspaceId) : undefined;
        if (!ws) {
            const folder = vscode.workspace.workspaceFolders?.[0];
            const dirPath = folder
                ? (folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString())
                : 'unknown';
            ws = this._getOrCreateWorkspace(dirPath);
        }
        const session: Runtime = {
            id: sessionId,
            host: hostName,
            cpus,
            memory,
            gpu,
            wallTime,
            queue,
            allocation,
            status: 'Pending',
            submittedAt: new Date(),
            type: 'remote',
            script,
        };
        ws.runtimes.push(session);

        // Store the session (not yet submitted) and send preview to the Sessions webview
        this._saveSessions();
        this._postSessionsMessage({ type: 'scriptPreview', sessionId: session.id, host: hostName, script });
    }

    /**
     * Ensure the linkspan binary is available locally by downloading the latest
     * release from GitHub if not already cached at ~/.cybershuttle/bin/linkspan.
     */
    async ensureLocalLinkspan(): Promise<string> {
        const binDir = path.join(os.homedir(), '.cybershuttle', 'bin');
        const binPath = path.join(binDir, 'linkspan');
        if (this._linkspanDownloaded && fs.existsSync(binPath)) {
            return binPath;
        }

        const deployStart = Date.now();
        this._metrics.record('linkspan_deploy', 'in_progress', { deploy_type: 'local' });

        const platformMap: Record<string, string> = { darwin: 'Darwin', linux: 'Linux', win32: 'Windows' };
        const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'arm64' };
        const osName = platformMap[process.platform];
        const archName = archMap[process.arch];
        if (!osName || !archName) {
            const errMsg = `Unsupported platform: ${process.platform}/${process.arch}`;
            this._metrics.record('linkspan_deploy', 'failure', { deploy_type: 'local' }, Date.now() - deployStart, errMsg);
            throw new Error(errMsg);
        }

        const assetName = `linkspan_${osName}_${archName}.tar.gz`;
        const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;

        this._outputChannel.appendLine(`Downloading linkspan from ${downloadUrl}`);
        fs.mkdirSync(binDir, { recursive: true });

        try {
            await new Promise<void>((resolve, reject) => {
                const proc = spawn('bash', ['-c', `curl -fsSL "${downloadUrl}" | tar -xz -C "${binDir}" linkspan && chmod +x "${binPath}"`], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stderr = '';
                proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
                proc.on('close', (code) => {
                    if (code === 0) { resolve(); }
                    else { reject(new Error(`Failed to download linkspan: ${stderr}`)); }
                });
                proc.on('error', reject);
            });

            this._linkspanDownloaded = true;
            this._outputChannel.appendLine('linkspan downloaded to ' + binPath);
            this._metrics.record('linkspan_deploy', 'success', { deploy_type: 'local' }, Date.now() - deployStart);
            return binPath;
        } catch (err: any) {
            this._metrics.record('linkspan_deploy', 'failure', { deploy_type: 'local' }, Date.now() - deployStart, err.message);
            throw err;
        }
    }

    /**
     * Send current auth state to the sessions webview and update the view title.
     */
    public postAuthState(account?: string | null) {
        const acct = account ?? this.tunnelManager.devTunnelAccount;
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
        const workflowYaml = generateLinkspanWorkflow(`ls-${hostSlug}-$SLURM_JOB_ID`, params.provider, params.serverUrl);

        const script = [
            `#!/bin/bash`,
            ...sbatchLines,
            ``,
            `# --- Set up log files using $HOME ---`,
            `LOG_DIR="$HOME/.cybershuttle/logs"`,
            `mkdir -p "$LOG_DIR"`,
            `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
            ``,
            `# --- Local linkspan overlay variables ---`,
            `export CS_LOCAL_TUNNEL_ID='${params.localTunnelId || ''}'`,
            `export CS_LOCAL_TUNNEL_TOKEN='${params.localTunnelToken || ''}'`,
            `export CS_LOCAL_SSH_PORT='${params.localSshPort || 0}'`,
            `export CS_LOCAL_WORKSPACE='${params.localWorkspace || ''}'`,
            `export CS_SESSION_ID='${sessionId || ''}'`,
            ``,
            `# --- Run linkspan (pre-deployed via scp) ---`,
            `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
            `"$LINKSPAN_BIN" --port 0 --tunnel-auth-token '${authToken}' --workflow - <<WORKFLOW_EOF`,
            workflowYaml,
            `WORKFLOW_EOF`,
        ].join('\n');

        return script;
    }

    /**
     * Generate a plain bash script (no SLURM directives) for non-SLURM hosts.
     */
    public generatePlainScript(params: {
        authToken: string;
        provider: string;
        serverUrl?: string;
        sessionId?: string;
        localTunnelId?: string;
        localTunnelToken?: string;
        localSshPort?: number;
        localWorkspace?: string;
    }): string {
        const { authToken, sessionId } = params;
        const workflowYaml = generateLinkspanWorkflow('ls-plain-$$', params.provider, params.serverUrl);

        const script = [
            `#!/bin/bash`,
            ``,
            `# --- Set up log files using $HOME ---`,
            `LOG_DIR="$HOME/.cybershuttle/logs"`,
            `mkdir -p "$LOG_DIR"`,
            `exec > "$LOG_DIR/linkspan-plain-$$.out" 2> "$LOG_DIR/linkspan-plain-$$.err"`,
            ``,
            `# --- Local linkspan overlay variables ---`,
            `export CS_LOCAL_TUNNEL_ID='${params.localTunnelId || ''}'`,
            `export CS_LOCAL_TUNNEL_TOKEN='${params.localTunnelToken || ''}'`,
            `export CS_LOCAL_SSH_PORT='${params.localSshPort || 0}'`,
            `export CS_LOCAL_WORKSPACE='${params.localWorkspace || ''}'`,
            `export CS_SESSION_ID='${sessionId || ''}'`,
            ``,
            `# --- Run linkspan (pre-deployed via scp) ---`,
            `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
            `"$LINKSPAN_BIN" --port 0 --tunnel-auth-token '${authToken}' --workflow - <<WORKFLOW_EOF`,
            workflowYaml,
            `WORKFLOW_EOF`,
        ].join('\n');

        return script;
    }

    /**
     * Submit a previously previewed SLURM job via sbatch over SSH.
     */
    private async submitJob(sessionId: string) {
        const session = this._findRuntime(sessionId)?.runtime;
        if (!session || !session.script) {
            vscode.window.showErrorMessage('Session not found or script missing.');
            return;
        }

        session.status = 'Submitting';
        this._saveSessions();
        this._sendRuntimeUpdates();
        this._updateStatusBar();

        const submitStart = Date.now();
        this._metrics.record('job_submit', 'in_progress', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Submitting job on ${session.host}`,
            cancellable: true,
        }, async (progress, token) => {
            this._outputChannel.appendLine(`\n--- Submitting SLURM job on ${session.host} ---`);

            try {
                // Set up local workspace info
                if (!this.isRemoteWindow && vscode.workspace.workspaceFolders?.[0]) {
                    const localWorkdir = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    session.localWorkdir = localWorkdir;
                    session.connectedRemotePath = `~/overlay/${session.id}`;
                    this._saveSessions();
                    // Require local linkspan to be running (user starts it via UI/command)
                    const localInfo = this._localLinkspan.get(localWorkdir);
                    if (!localInfo?.tunnelId) {
                        throw new Error('Local linkspan is not running. Start it first via the Sessions panel or "CyberShuttle: Start Linkspan" command.');
                    }
                    const creds = await this.tunnelManager.getCredentials();
                    const localParams = {
                        localTunnelId: localInfo.tunnelId,
                        localTunnelToken: localInfo.tunnelToken,
                        localSshPort: localInfo.sshPort,
                        localWorkspace: localWorkdir,
                    };
                    if (session.noSlurm) {
                        session.script = this.generatePlainScript({ authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, ...localParams });
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
                const result = await this._ssh.runRemoteCommand(session.host, submitCmd, token);

                if (result.code === 0) {
                    if (session.noSlurm) {
                        const pidMatch = result.stdout.match(/PID:(\d+)/);
                        session.slurmJobId = pidMatch ? `pid-${pidMatch[1]}` : undefined;
                        session.status = 'Active';
                        session.errorMessage = undefined;
                        this._outputChannel.appendLine(result.stdout);
                        progress.report({ message: 'Session started — waiting for tunnel...' });
                        this._startSessionPolling();
                    } else {
                        const match = result.stdout.match(/Submitted batch job (\d+)/);
                        session.slurmJobId = match ? match[1] : undefined;
                        session.status = 'Pending';
                        session.errorMessage = undefined;
                        this._outputChannel.appendLine(result.stdout);
                        progress.report({ message: `Job ${session.slurmJobId || ''} submitted — waiting for node allocation...` });
                        this._startSessionPolling();
                    }
                    this._metrics.record('job_submit', 'success', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime, job_id_slurm: session.slurmJobId }, Date.now() - submitStart);
                } else {
                    session.status = 'Failed';
                    const errLines = (result.stderr || '').split('\n')
                        .map((l: string) => l.replace(/^sbatch:\s*error:\s*/i, '').trim())
                        .filter((l: string) => l.length > 0);
                    session.errorMessage = errLines.join(' ') || `exit code ${result.code}`;
                    this._outputChannel.appendLine(`Submit exited with code ${result.code}`);
                    if (result.stderr) {
                        this._outputChannel.appendLine(result.stderr);
                    }
                    vscode.window.showErrorMessage(`Failed to start session on ${session.host}: ${session.errorMessage}`);
                    this._metrics.record('job_submit', 'failure', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime }, Date.now() - submitStart, session.errorMessage);
                }
            } catch (err: any) {
                if (err.cancelled) {
                    session.status = 'Failed';
                    session.errorMessage = 'Cancelled by user';
                    this._outputChannel.appendLine('Job submission cancelled by user');
                    vscode.window.showInformationMessage(`Job submission on ${session.host} cancelled.`);
                } else {
                    session.status = 'Failed';
                    session.errorMessage = err.message;
                    this._outputChannel.appendLine(`Error: ${err.message}`);
                    vscode.window.showErrorMessage(`Failed to submit job: ${err.message}`);
                }
                this._metrics.record('job_submit', 'failure', { cluster: session.host }, Date.now() - submitStart, session.errorMessage);
            }

            // If submission failed, stop VFS providers (no point keeping them running)
            if (session.status === 'Failed') {
                await this._syncProvider.stop(session);
                await this._mountProvider.stop(session);
            }

            this._saveSessions();
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
        // Always re-deploy to ensure the latest release is running.
        // The download URL points to /latest/download/ which resolves
        // to the newest GitHub release automatically.
        this._metrics.record('linkspan_deploy', 'in_progress', { deploy_type: 'remote', target_host: hostName });
        try {
            // Detect remote architecture
            const archResult = await this._ssh.runRemoteCommand(hostName, 'uname -m', token);
            if (archResult.code !== 0) {
                throw new Error('Failed to detect remote architecture');
            }
            let arch = archResult.stdout.trim();
            if (arch === 'aarch64') { arch = 'arm64'; }

            // Download latest release from GitHub directly on the remote host
            const assetName = `linkspan_Linux_${arch}.tar.gz`;
            const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;
            await this._ssh.runRemoteCommand(hostName, `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`, token);
            this._outputChannel.appendLine('linkspan deployed to ' + hostName);
            this._metrics.record('linkspan_deploy', 'success', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart);
        } catch (err: any) {
            this._metrics.record('linkspan_deploy', 'failure', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart, err.message);
            throw err;
        }
    }

    /**
     * Fetch session log files from the remote host and display in the output channel.
     */
    private async viewSessionLogs(sessionId: string) {
        const session = this._findRuntime(sessionId)?.runtime;
        if (!session || !session.slurmJobId) {
            vscode.window.showErrorMessage('Session not found or no SLURM job ID available.');
            return;
        }

        const jobId = session.slurmJobId;
        const logBase = `$HOME/.cybershuttle/logs/linkspan-session-${jobId}`;
        this._outputChannel.appendLine(`\n--- Fetching logs for Job ${jobId} on ${session.host} ---`);

        try {
            const cmd = [
                `echo '=== STDOUT ==='`,
                `if [ -f ${logBase}.out ]; then tail -c 65536 ${logBase}.out; else echo '[No stdout log found]'; fi`,
                `echo ''`,
                `echo '=== STDERR ==='`,
                `if [ -f ${logBase}.err ]; then tail -c 65536 ${logBase}.err; else echo '[No stderr log found]'; fi`,
            ].join(' && ');
            const result = await this._ssh.runRemoteCommand(session.host, cmd);
            if (result.code === 0) {
                this._outputChannel.appendLine(result.stdout);
            } else {
                this._outputChannel.appendLine(`Failed to fetch logs (exit code ${result.code})`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`Error fetching logs: ${err.message}`);
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
        if (this._logTailProcesses.has(sessionId)) {
            this.stopSessionLogStream(sessionId);
            return;
        }

        const session = this._findRuntime(sessionId)?.runtime;
        if (!session || !session.logPort || !session._portMap) {
            this._outputChannel.appendLine(`[linkspan-${session?.host}] Cannot stream logs: no log port or tunnel not connected`);
            return;
        }

        const localLogPort = session._portMap.get(session.logPort);
        if (!localLogPort) {
            this._outputChannel.appendLine(`[linkspan-${session.host}] Log port ${session.logPort} not in tunnel port map`);
            return;
        }

        const logTag = `[linkspan-${session.host}]`;
        const sock = new net.Socket();
        sock.connect(localLogPort, '127.0.0.1', () => {
            this._outputChannel.appendLine(`${logTag} connected to log stream (port ${localLogPort})`);
        });

        sock.on('data', (data: Buffer) => {
            const text = data.toString();
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    this._outputChannel.appendLine(`${logTag} ${line}`);
                }
            }
            this._postSessionsMessage({
                type: 'sessionLogData',
                sessionId,
                text,
            });
        });

        sock.on('error', (err: Error) => {
            this._outputChannel.appendLine(`${logTag} log stream error: ${err.message}`);
        });

        sock.on('close', () => {
            this._outputChannel.appendLine(`${logTag} log stream disconnected`);
            this._logTailProcesses.delete(sessionId);
            this._postSessionsMessage({ type: 'sessionLogStopped', sessionId });
        });

        // Store socket wrapped in a ChildProcess-like shape for cleanup
        const fakeProc: any = { kill: () => sock.destroy(), pid: -1 };
        fakeProc._logSocket = sock;
        this._logTailProcesses.set(sessionId, fakeProc);
        this._postSessionsMessage({ type: 'sessionLogStarted', sessionId });
    }

    private stopSessionLogStream(sessionId: string) {
        const proc = this._logTailProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this._logTailProcesses.delete(sessionId);
        }
        this._postSessionsMessage({ type: 'sessionLogStopped', sessionId });
    }

    private stopAllLogStreams() {
        for (const [, proc] of this._logTailProcesses) {
            proc.kill();
        }
        this._logTailProcesses.clear();
    }

    private stopAllLocalProcesses() {
        for (const [, proc] of this._localProcesses) {
            proc.kill();
        }
        this._localProcesses.clear();
    }

    private async relaunchSession(sessionId: string) {
        const session = this._findRuntime(sessionId)?.runtime;
        if (!session) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }

        // Generate script on demand if missing
        if (!session.script) {
            let creds: TunnelCredentials;
            try {
                creds = await this.tunnelManager.getCredentials();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
                return;
            }
            const localInfo = session.localWorkdir ? this._localLinkspan.get(session.localWorkdir) : undefined;
            const localParams = {
                localTunnelId: localInfo?.tunnelId,
                localTunnelToken: localInfo?.tunnelToken,
                localSshPort: localInfo?.sshPort,
                localWorkspace: session.localWorkdir,
            };
            if (session.noSlurm) {
                session.script = this.generatePlainScript({ authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, ...localParams });
            } else {
                session.script = this.generateSlurmScript({
                    cpus: session.cpus, memory: session.memory, gpu: session.gpu,
                    wallTime: session.wallTime, queue: session.queue, allocation: session.allocation,
                    authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, ...localParams,
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
        this._saveSessions();

        // Show preview and let user confirm
        this._postSessionsMessage({ type: 'scriptPreview', sessionId: session.id, host: session.host, script: session.script });
    }

    /**
     * Cancel a pending job preview (remove the session that was created during preview).
     */
    private cancelJobPreview(sessionId: string) {
        const found = this._findRuntime(sessionId);
        if (found) {
            found.workspace.runtimes = found.workspace.runtimes.filter(r => r.id !== sessionId);
            if (found.workspace.runtimes.length === 0) {
                this._workspaces = this._workspaces.filter(w => w.id !== found.workspace.id);
            }
        }
        this._saveSessions();
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
            creds = await this.tunnelManager.getCredentials();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get tunnel credentials: ${err.message}`);
            return;
        }

        const tunnelName = `ls-${sessionId}`;
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
        this._saveSessions();
        this.refresh();

        this._outputChannel.appendLine(`\n--- Starting local linkspan session ---`);

        try {
            await this._launchLinkspanProcess(session, creds.authToken);
            vscode.window.showInformationMessage('Local linkspan session started');
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = err.message;
            this._saveSessions();
            this.refresh();
            vscode.window.showErrorMessage(`Failed to start linkspan: ${err.message}`);
        }
    }

    /**
     * Re-launch a local linkspan session whose process died (e.g. after VS Code restart).
     * Clears stale runtime state, cleans up the old tunnel, and re-runs the saved workflow.
     */
    private async _resumeLocalSession(session: Runtime) {
        this._outputChannel.appendLine(`\n--- Resuming local session ${session.id} ---`);

        // Clear stale runtime state but preserve tunnel info (tunnelUrl,
        // tunnelToken, tunnelId) — if the tunnel is still live the user
        // can reconnect immediately.  The linkspan workflow will overwrite
        // these values once it re-captures them.
        session.localPid = undefined;
        session.sshPort = undefined;
        session.logPort = undefined;
        session.status = 'Submitting';
        this._saveSessions();
        this.refresh();

        let creds: TunnelCredentials;
        try {
            creds = await this.tunnelManager.getCredentials();
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = `Resume failed: ${err.message}`;
            this._saveSessions();
            this.refresh();
            return;
        }

        try {
            await this._launchLinkspanProcess(session, creds.authToken);
            this._outputChannel.appendLine(`Local session ${session.id} resumed`);
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = `Resume failed: ${err.message}`;
            this._saveSessions();
            this.refresh();
        }
    }

    /**
     * Spawn a linkspan process for a local session, wire up output parsing and lifecycle handlers.
     * Used by both testLocal() (new sessions) and _resumeLocalSession() (restarted sessions).
     */
    private async _launchLinkspanProcess(session: Runtime, authToken: string) {
        const linkspanPath = await this.ensureLocalLinkspan();
        const proc = spawn(linkspanPath, ['--port', '0', '--tunnel-auth-token', authToken, '--workflow', '-'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        this._localProcesses.set(session.id, proc);
        session.localPid = proc.pid;
        session.status = 'Active';
        this._saveSessions();
        this.refresh();

        proc.stdin!.write(session.script);
        proc.stdin!.end();

        // Parse linkspan workflow output for captured variables and errors.
        // The workflow engine logs:
        //   "workflow: captured <var> = <value>"  — variable captures
        //   "workflow: workflow step N (...): Error: ..."  — step failures
        const parseOutput = (text: string) => {
            for (const line of text.split('\n')) {
                // Capture workflow variables
                const cap = line.match(/workflow: captured (\S+) = (.+)/);
                if (cap) {
                    const [, varName, value] = cap;
                    this._applyWorkflowCapture(session, varName, value);
                    if (varName === 'tunnel_url') {
                        this._metrics.record('tunnel_create', 'success', { tunnel_type: this.tunnelManager.getProvider(), target_host: session.host });
                    }
                    this._saveSessions();
                    this.refresh();
                    continue;
                }

                // Detect workflow step errors
                const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): (.+)/);
                if (errMatch) {
                    const [, stepName, errMsg] = errMatch;
                    session.status = 'Failed';
                    session.errorMessage = `${stepName}: ${errMsg.trim()}`;
                    this._saveSessions();
                    this.refresh();
                    vscode.window.showErrorMessage(`Linkspan workflow failed — ${stepName}: ${errMsg.trim()}`);
                    this._metrics.record('tunnel_create', 'failure', { tunnel_type: this.tunnelManager.getProvider(), target_host: session.host }, undefined, session.errorMessage);
                    continue;
                }

                // Detect fatal errors (e.g. "failed to listen", panic, etc.)
                const fatal = line.match(/(?:fatal|FATAL|panic): (.+)/);
                if (fatal) {
                    session.status = 'Failed';
                    session.errorMessage = fatal[1].trim();
                    this._saveSessions();
                    this.refresh();
                    vscode.window.showErrorMessage(`Linkspan error: ${fatal[1].trim()}`);
                }
            }
        };

        proc.stdout!.on('data', (data: Buffer) => {
            const text = data.toString();
            this._outputChannel.appendLine(text.trimEnd());
            parseOutput(text);
        });

        proc.stderr!.on('data', (data: Buffer) => {
            const text = data.toString();
            this._outputChannel.appendLine(text.trimEnd());
            parseOutput(text);
        });

        proc.on('close', (code) => {
            this._localProcesses.delete(session.id);
            // During extension disposal, don't update session state — we want
            // sessions to remain Active so they're resumed on next startup.
            if (this._disposing) { return; }
            const s = this._findRuntime(session.id)?.runtime;
            if (s) {
                // Only update status if not already marked as Failed by error parsing
                if (s.status !== 'Failed') {
                    s.status = code === 0 ? 'Completed' : 'Failed';
                    if (code !== 0 && code !== null) {
                        s.errorMessage = `linkspan exited with code ${code}`;
                        vscode.window.showErrorMessage(`Linkspan exited with code ${code}. Check output for details.`);
                    }
                }
                s.localPid = undefined;
                this._saveSessions();
                this.refresh();
            }
            this._outputChannel.appendLine(`\n--- Local linkspan session ended (exit code ${code}) ---`);
        });

        proc.on('error', (err) => {
            this._localProcesses.delete(session.id);
            if (this._disposing) { return; }
            const s = this._findRuntime(session.id)?.runtime;
            if (s) {
                s.status = 'Failed';
                s.errorMessage = err.message;
                s.localPid = undefined;
                this._saveSessions();
                this.refresh();
            }
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Local linkspan failed: ${err.message}`);
        });
    }

    /**
     * Connect to a remote session's tunnel via the local linkspan REST API.
     * Returns the port map (remotePort → localPort) or undefined on failure.
     */
    private async _connectViaTunnel(sessionId: string, session: Runtime): Promise<Map<number, number> | undefined> {
        if (!session.tunnelId || !session.tunnelToken) {
            this._outputChannel.appendLine('[tunnel] Missing tunnelId or tunnelToken');
            return undefined;
        }

        // Already connected — return cached port map
        if (session.connectionId && session._portMap) {
            return session._portMap;
        }

        // Use existing local linkspan — do NOT auto-start it
        const workspacePath = session.localWorkdir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localInfo = workspacePath ? this._localLinkspan.get(workspacePath) : undefined;

        if (!localInfo) {
            this._outputChannel.appendLine('[tunnel] Local linkspan not running, cannot connect. Start it first.');
            return undefined;
        }

        const provider = this.tunnelManager.getProvider();
        const baseUrl = `http://127.0.0.1:${localInfo.serverPort}`;
        this._outputChannel.appendLine(`[tunnel] Connecting to tunnel ${session.tunnelId} via linkspan REST (provider=${provider}, port=${localInfo.serverPort}, pid=${localInfo.pid})`);

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
                this._outputChannel.appendLine(`[tunnel] Connect failed (${resp.status}): ${body}`);
                return undefined;
            }

            const result: any = await resp.json();
            session.connectionId = result.connectionId;
            const portMap = new Map<number, number>();
            for (const [remoteStr, localPort] of Object.entries(result.portMap)) {
                const remotePort = parseInt(remoteStr, 10);
                portMap.set(remotePort, localPort as number);
                this._outputChannel.appendLine(`[tunnel] Port mapped: remote ${remotePort} → local ${localPort}`);
            }
            session._portMap = portMap;
            this._saveSessions();
            this._outputChannel.appendLine(`[tunnel] Connected (connectionId=${result.connectionId})`);
            return portMap;
        } catch (err: any) {
            const cause = err.cause ? ` (cause: ${err.cause?.message || err.cause?.code || err.cause})` : '';
            this._outputChannel.appendLine(`[tunnel] Connect failed: ${err.message}${cause}`);
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
        const localInfo = workspacePath ? this._localLinkspan.get(workspacePath) : undefined;
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
            this._outputChannel.appendLine(`[tunnel] Disconnected (connectionId=${session.connectionId})`);
        } catch (err: any) {
            this._outputChannel.appendLine(`[tunnel] Disconnect failed: ${err.message}`);
        }

        session.connectionId = undefined;
        session._portMap = undefined;
    }

    /**
     * Apply a workflow variable capture to a session.
     * Returns true if the variable was recognized and applied.
     */
    private _applyWorkflowCapture(session: Runtime, varName: string, value: string): boolean {
        if (varName === 'ssh_port') {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) { session.sshPort = n; }
        } else if (varName === 'log_port') {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) { session.logPort = n; }
        } else if (varName === 'tunnel_url') {
            session.tunnelUrl = value.trim();
        } else if (varName === 'tunnel_token') {
            session.tunnelToken = value.trim();
        } else if (varName === 'tunnel_id') {
            session.tunnelId = value.trim();
        } else {
            return false;
        }
        return true;
    }

    /**
     * Full teardown for a terminal session: sync-back, cleanup connections,
     * delete tunnel, clear session fields. Caller sets session.status first.
     */
    private async _teardownSession(session: Runtime, sessionId: string, logTag: string): Promise<void> {
        if (this._tearingDown.has(sessionId)) {
            this._outputChannel.appendLine(`[${logTag}] Teardown already in progress for ${sessionId}, skipping`);
            return;
        }
        this._tearingDown.add(sessionId);
        try {
        // 0. Stop continuous sync (flush + terminate mutagen)
        if ((session as any).mutagenSessionName) {
            try {
                await this._dataCache.stopContinuousSync(session.id);
                (session as any).mutagenSessionName = undefined;
            } catch (err: any) {
                this._outputChannel.appendLine(`[${logTag}] Failed to stop continuous sync: ${err.message}`);
            }
        }

        // 1. Sync back FIRST (while connection is alive)
        if (session.localWorkdir && session.status !== 'Failed') {
            try {
                session.syncProgress = { transferred: 0, total: 0 };
                this._dataCache.onProgress = (transferred: number, total: number) => {
                    session.syncProgress = { transferred, total };
                    this.refreshSessionsView();
                };
                await this._dataCache.unstage(session.localWorkdir, session.host, session.id, (h: string, cmd: string) => this._ssh.runRemoteCommand(h, cmd));
                session.syncProgress = undefined;
                this._dataCache.onProgress = undefined;
                this.refreshSessionsView();
            } catch (err: any) {
                session.syncProgress = undefined;
                this._dataCache.onProgress = undefined;
                this._outputChannel.appendLine(`[${logTag}] Warning: Sync-back failed: ${err.message}`);
            }
        }

        // 2. Clean up connections (VFS, tunnel, SSH config)
        await this._cleanupSessionConnections(session, sessionId);

        // 3. Delete main session tunnel
        await this._deleteTunnel(session);

        // 4. Clear Tier 2 + Tier 3 fields and credentials
        this._clearSessionFields(session);
        } finally {
            this._tearingDown.delete(sessionId);
        }
    }

    /**
     * Clean up session connections: mutagen sync, tunnel, SSH config.
     */
    private async _cleanupSessionConnections(session: Runtime, sessionId: string): Promise<void> {
        // 1. Stop VFS provider (mutagen sync or sshfs mount)
        await this._syncProvider.stop(session);
        await this._mountProvider.stop(session);

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

        const provider = this.tunnelManager.getProvider();

        // Try linkspan REST API first
        const workspacePath = session.localWorkdir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const localInfo = workspacePath ? this._localLinkspan.get(workspacePath) : undefined;
        if (localInfo && session.tunnelId) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10_000);
                await fetch(`http://127.0.0.1:${localInfo.serverPort}/api/v1/tunnels/${session.tunnelId}?provider=${provider}`, {
                    method: 'DELETE',
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                this._outputChannel.appendLine(`[tunnel] Deleted tunnel ${session.tunnelId} via linkspan REST`);
                return;
            } catch (err: any) {
                this._outputChannel.appendLine(`[tunnel] REST delete failed, trying CLI fallback: ${err.message}`);
            }
        }

        // Fallback: devtunnel CLI (only works for devtunnel provider)
        if (provider === 'devtunnel' && session.slurmJobId) {
            const dtBin = this.tunnelManager.resolveDevTunnelBin();
            if (!dtBin) { return; }
            const hostSlug = (session.host || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-');
            const tunnelName = session.noSlurm
                ? `ls-plain-${session.slurmJobId.replace('pid-', '')}`
                : `ls-${hostSlug}-${session.slurmJobId}`;
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
     * Clear Tier 2 + Tier 3 fields and credentials from a session.
     */
    private _clearSessionFields(session: Runtime): void {
        session.script = undefined;
        session.tunnelUrl = undefined;
        session.tunnelToken = undefined;
        session.tunnelId = undefined;
        session.sshPort = undefined;
        session.logPort = undefined;
        session.computeNode = undefined;
        session.sshTunnelLocalPort = undefined;
        session.connectionId = undefined;
        session._portMap = undefined;
        session.errorMessage = undefined;
    }

    /**
     * Start a background linkspan process serving the local workdir over FUSE
     * with a devtunnel, so a remote session can mount it.
     * @deprecated Use local linkspan with tunnel.connect instead
     */
    private async startLocalFuseServer(session: Runtime, authToken: string): Promise<void> {
        const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workdir) {
            this._outputChannel.appendLine('[fuse-server] No workspace folder open, skipping local FUSE server');
            return;
        }

        session.localWorkdir = workdir;

        const linkspanPath = await this.ensureLocalLinkspan();
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
                        this._saveSessions();
                        this.refresh();
                    }

                    // Check if all FUSE info is captured
                    if (session.localFusePort && session.localFuseTunnelId && session.localFuseConnectToken && !resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        this._outputChannel.appendLine(
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
                this._outputChannel.appendLine(`[fuse-server] ${text.trimEnd()}`);
                parseOutput(text);
            });

            proc.stderr!.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.appendLine(`[fuse-server] ${text.trimEnd()}`);
                parseOutput(text);
            });

            proc.on('close', (code) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`FUSE server process exited with code ${code}`));
                }
                session.localFuseServerPid = undefined;
                this._saveSessions();
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
        const session = this._findRuntime(sessionId)?.runtime;
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
            this._saveSessions();

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
     * Path to the internal SSH config file managed by CS-Bridge.
     * Entries are kept here instead of polluting ~/.ssh/config directly.
     */
    private get _internalSshConfigPath(): string {
        return path.join(os.homedir(), '.cybershuttle', 'ssh_config');
    }

    /**
     * Ensure ~/.ssh/config includes our internal config file so that
     * VS Code Remote-SSH (and plain ssh) can resolve cs-session-* / cs-tunnel-* hosts.
     */
    private _ensureSshInclude(): void {
        const sshDir = path.join(os.homedir(), '.ssh');
        const sshConfigPath = path.join(sshDir, 'config');
        const includeLine = `Include ${this._internalSshConfigPath}`;

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
            this._outputChannel.appendLine(`[ssh] Failed to add Include to ~/.ssh/config: ${err.message}`);
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
            const internalPath = this._internalSshConfigPath;
            const existing = fs.existsSync(internalPath) ? fs.readFileSync(internalPath, 'utf-8') : '';
            fs.writeFileSync(internalPath, existing + matches.join(''));
            // Remove from ~/.ssh/config
            const cleaned = content.replace(re, '');
            fs.writeFileSync(sshConfigPath, cleaned);
            this._outputChannel.appendLine(`[ssh] Migrated ${matches.length} CS-Bridge entries from ~/.ssh/config to internal config`);
        } catch (err: any) {
            this._outputChannel.appendLine(`[ssh] Migration failed: ${err.message}`);
        }
    }

    /**
     * Remove any CS-Bridge SSH config entry for the given session/host alias.
     */
    private _removeSshConfigEntry(sessionId: string, hostAlias: string): void {
        const configPath = this._internalSshConfigPath;
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

        const configPath = this._internalSshConfigPath;
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
        const session = this._findRuntime(sessionId)?.runtime;
        if (!session || !session.remoteFusePort) {
            return;
        }

        let linkspanPath: string;
        try {
            linkspanPath = await this.ensureLocalLinkspan();
        } catch (err: any) {
            this._outputChannel.appendLine(`[fuse-mount] Failed to get linkspan binary: ${err.message}`);
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
                this._outputChannel.appendLine('[fuse-mount] Dev Tunnel not available, skipping mount');
                return;
            }

            const localFusePort = portMap.get(session.remoteFusePort);
            if (!localFusePort) {
                this._outputChannel.appendLine(`[fuse-mount] FUSE port ${session.remoteFusePort} was not forwarded by Dev Tunnel`);
                return;
            }
            fuseAddr = `127.0.0.1:${localFusePort}`;
        } else {
            this._outputChannel.appendLine('[fuse-mount] Missing compute node or host info, skipping FUSE mount');
            return;
        }

        this._outputChannel.appendLine(`\n--- Starting NFS mount for session ${sessionId} (${fuseAddr}) ---`);

        const proc = spawn(linkspanPath, [
            '--mount-remote',
            '--session-id', sessionId,
            '--server-addr', fuseAddr,
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        session.fuseMountPid = proc.pid;
        this._saveSessions();

        proc.stdout!.on('data', (data: Buffer) => {
            const text = data.toString();
            this._outputChannel.appendLine(`[fuse-mount] ${text.trimEnd()}`);

            for (const line of text.split('\n')) {
                const mountPath = line.match(/MOUNT_PATH=(.+)/);
                if (mountPath) {
                    session.localMountPath = mountPath[1].trim();
                    this._saveSessions();
                    this.refresh();
                }
            }
        });

        proc.stderr!.on('data', (data: Buffer) => {
            this._outputChannel.appendLine(`[fuse-mount/err] ${data.toString().trimEnd()}`);
        });

        proc.on('close', () => {
            const s = this._findRuntime(sessionId)?.runtime;
            if (s) {
                s.fuseMountPid = undefined;
                s.localMountPath = undefined;
                this._saveSessions();
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
                this._outputChannel.appendLine(`[tunnel] Port ${port} reachable (attempt ${attempt}/${maxRetries})`);
                return true;
            }
            this._outputChannel.appendLine(`[tunnel] Port ${port} not reachable, retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`);
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
            this._outputChannel.appendLine('[devtunnel] Missing tunnelId or tunnelToken');
            return undefined;
        }

        // Already connected — return cached port map
        if (session.devtunnelConnectPid && session._devtunnelPortMap) {
            return session._devtunnelPortMap;
        }

        const devtunnelBin = this._resolveDevTunnelBin();
        if (!devtunnelBin) {
            this._outputChannel.appendLine('[devtunnel] ERROR: devtunnel binary not found');
            return undefined;
        }

        this._outputChannel.appendLine(
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
                        this._outputChannel.appendLine(`[devtunnel] Timeout but got ${portMap.size} port(s), proceeding`);
                        session._devtunnelPortMap = portMap;
                        resolve(portMap);
                    } else {
                        this._outputChannel.appendLine('[devtunnel] Timed out waiting for port forwarding');
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
                this._outputChannel.appendLine(`[devtunnel] ERROR: spawn failed: ${err.message}`);
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(undefined);
                }
            });

            if (!tunnelProc.pid) {
                this._outputChannel.appendLine('[devtunnel] ERROR: process did not start (no PID)');
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(undefined);
                }
                return;
            }

            session.devtunnelConnectPid = tunnelProc.pid;
            this._saveSessions();

            // Parse: "SSH: Forwarding from 127.0.0.1:<local> to host port <remote>."
            const forwardingRe = /Forwarding from 127\.0\.0\.1:(\d+) to host port (\d+)/;

            const checkOutput = (text: string) => {
                for (const line of text.split('\n')) {
                    const m = line.match(forwardingRe);
                    if (m) {
                        const localPort = parseInt(m[1], 10);
                        const remotePort = parseInt(m[2], 10);
                        portMap.set(remotePort, localPort);
                        this._outputChannel.appendLine(`[devtunnel] Port mapped: remote ${remotePort} → local ${localPort}`);
                    }
                }
                // Resolve once we've seen forwarding lines for all expected ports
                if (!resolved && portMap.size > 0 && (expectedPorts.size === 0 || [...expectedPorts].every(p => portMap.has(p)))) {
                    resolved = true;
                    clearTimeout(timeout);
                    session._devtunnelPortMap = portMap;
                    this._outputChannel.appendLine('[devtunnel] All expected ports forwarded');
                    resolve(portMap);
                }
            };

            tunnelProc.stdout.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.appendLine(`[devtunnel] ${text.trimEnd()}`);
                checkOutput(text);
            });

            tunnelProc.stderr.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.appendLine(`[devtunnel/err] ${text.trimEnd()}`);
                checkOutput(text);
            });

            tunnelProc.on('close', (code: number | null) => {
                this._outputChannel.appendLine(`[devtunnel] connect exited (code ${code})`);
                const s = this._findRuntime(sessionId)?.runtime;
                if (s) {
                    s.devtunnelConnectPid = undefined;
                    s.sshTunnelLocalPort = undefined;
                    s._devtunnelPortMap = undefined;
                }
                this._removeSshConfigEntry(sessionId, `cs-session-${sessionId}`);
                this._saveSessions();
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
        const session = this._findRuntime(sessionId)?.runtime;
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
            this._saveSessions();
            this._sendRuntimeUpdates();
            await this._teardownSession(session, sessionId, 'stop');

            // 2. Cancel SLURM job
            this._outputChannel.appendLine(`\n--- Cancelling SLURM job ${session.slurmJobId} on ${session.host} ---`);
            progress.report({ message: 'Cancelling SLURM job...' });
            try {
                const result = await this._ssh.runRemoteCommand(session.host, `scancel ${session.slurmJobId}`);
                if (result.code === 0) {
                    this._outputChannel.appendLine(`Job ${session.slurmJobId} cancelled.`);
                } else {
                    this._outputChannel.appendLine(`scancel failed: ${result.stderr}`);
                }
            } catch (err: any) {
                this._outputChannel.appendLine(`Error cancelling job: ${err.message}`);
            }

            // 3. Clean remote session dir (best-effort, don't block)
            progress.report({ message: 'Cleaning remote workspace...' });
            try {
                await this._ssh.runRemoteCommand(session.host, `rm -rf ~/sessions/${sessionId} ~/overlay/${sessionId}`);
            } catch { /* best-effort */ }

            session.status = 'Completed';
            this.stopSessionLogStream(sessionId);
            this._saveSessions();
            this.refresh();
        });

        // If we're in a remote window connected to this session, switch back to local
        if (this.isRemoteWindow) {
            const activeSession = this._detectActiveSession();
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
        const session = this._findRuntime(sessionId)?.runtime;
        if (!session) { return; }

        this._outputChannel.appendLine(`[session] Session ${sessionId} expired, cleaning up`);

        // 1. Full teardown: sync-back, cleanup connections, delete tunnel, clear fields
        session.status = 'Stopping';
        this._saveSessions();
        this._sendRuntimeUpdates();
        await this._teardownSession(session, sessionId, 'expire');
        session.status = 'Completed';

        // 2. Clean remote session dir (best-effort)
        if (session.host && !session.isLocal) {
            try {
                await this._ssh.runRemoteCommand(session.host, `rm -rf ~/sessions/${sessionId} ~/overlay/${sessionId}`);
            } catch { /* best-effort */ }
        }

        this.stopSessionLogStream(sessionId);
        this._saveSessions();
        this.refresh();

        // Prompt switch to local if we're in this session's remote window
        if (this.isRemoteWindow) {
            const activeSession = this._detectActiveSession();
            if (activeSession?.id === sessionId) {
                this._promptSwitchToLocal(session, 'Session expired. Remote connection will be lost.');
            }
        }
    }

    private async stopLocalSession(sessionId: string) {
        const session = this._findRuntime(sessionId)?.runtime;
        if (!session) { return; }

        // 1. Clean up connections (mutagen, tunnel, SSH config)
        await this._cleanupSessionConnections(session, sessionId);

        // 2. Kill linkspan process
        const proc = this._localProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this._localProcesses.delete(sessionId);
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
        this._saveSessions();
        this.refresh();
    }

    /**
     * Refresh session statuses by querying squeue on the remote host.
     * Only checks sessions that still need setup monitoring.
     * RUNNING → Active, PENDING → Pending, no output → completed/removed.
     */
    private async refreshSessions() {
        // Only check sessions that still need setup polling
        const sessionsToCheck = this._allRuntimes().filter(s => this._sessionNeedsSetupPolling(s));
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
                    this._metrics.record('job_status_change', session.status === 'Failed' ? 'failure' : 'success', {
                        job_id_slurm: session.slurmJobId,
                        old_status: oldStatus,
                        new_status: session.status,
                        cluster: session.host,
                    });

                    // If this session just became terminal and we're in its remote window, prompt switch
                    if ((session.status === 'Failed' || session.status === 'Completed') && this.isRemoteWindow) {
                        const activeSession = this._detectActiveSession();
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
                await this.pollLinkspanWorkflow(session);

                // Event-driven tunnel connect: trigger once when tunnelUrl first appears
                if (!hadTunnelUrl && session.tunnelUrl && session.tunnelToken && session.tunnelId
                    && session.status === 'Active' && !session._portMap && !session.connectionId) {
                    try {
                        this._outputChannel.appendLine(`[poll] Tunnel URL discovered for ${session.id}, auto-connecting...`);
                        const portMap = await this._connectViaTunnel(session.id, session);
                        if (portMap && session.logPort && !this._logTailProcesses.has(session.id)) {
                            this.toggleSessionLogStream(session.id);
                        }
                    } catch (err: any) {
                        this._outputChannel.appendLine(`[poll] Auto-connect tunnel failed for ${session.id}: ${err.message}`);
                    }
                }

                // Auto-switch if runtime just became active and has switchOnReady
                if (session.switchOnReady && session.status === 'Active' && session.tunnelUrl) {
                    session.switchOnReady = false;
                    this._saveSessions();
                    try {
                        await this.switchToRemote(session.id);
                    } catch (err: any) {
                        this._outputChannel.appendLine(`[auto-switch] Failed to switch to ${session.id}: ${err.message}`);
                    }
                }
            } catch (err: any) {
                this._outputChannel.appendLine(`[poll] Error checking session ${session.id}: ${err.message}`);
            }
        }

        this._saveSessions();
        this._sendRuntimeUpdates();
        this._updateStatusBar();

        // Push active sessions metadata to local linkspan
        const workspaceSessions = new Map<string, any[]>();
        for (const session of this._allRuntimes()) {
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
            await this._localLinkspan.setMetadata(ws, 'sessions', sessions);
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
                const result = await this._ssh.runRemoteCommand(session.host, `kill -0 ${pid} 2>/dev/null && echo RUNNING || echo STOPPED`);
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
            const result = await this._ssh.runRemoteCommand(session.host, `squeue -j ${session.slurmJobId} -h -o "%T %N"`);
            this._metrics.record('sinfo_fetch', 'success', { cluster: session.host, raw_output_truncated: result.stdout.slice(0, 200) }, Date.now() - squeueStart);
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
                    const sacctResult = await this._ssh.runRemoteCommand(session.host, `sacct -j ${session.slurmJobId} -n -o State%20,ExitCode,Reason%40 --parsable2 2>/dev/null | head -1`);
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
     * Poll linkspan for workflow status.  Two modes:
     * - Bootstrap (no tunnelUrl yet): one SSH call to read SLURM stderr logs and
     *   discover the tunnel URL from the first workflow step.
     * - Direct (tunnelUrl known): fetch /api/v1/status through the tunnel.
     */
    private async pollLinkspanWorkflow(session: Runtime): Promise<void> {
        if (!session.slurmJobId) { return; }

        // All workflow variables captured — nothing left to poll for
        if (session.tunnelUrl && session.tunnelToken && session.sshPort && session.logPort) { return; }

        // Once tunnel URL is known, use the API exclusively
        if (session.tunnelUrl) {
            await this._pollLinkspanStatus(session);
            return;
        }

        // Bootstrap: parse SLURM stderr logs via SSH to discover tunnel_url
        const logPrefix = session.noSlurm ? 'linkspan-plain-' : 'linkspan-session-';
        const logId = session.noSlurm ? session.slurmJobId.replace('pid-', '') : session.slurmJobId;
        const logFile = `$HOME/.cybershuttle/logs/${logPrefix}${logId}.err`;
        try {
            const result = await this._ssh.runRemoteCommand(session.host, `if [ -f ${logFile} ]; then tail -c 65536 ${logFile}; fi`);
            if (result.code !== 0 || !result.stdout) { return; }

            for (const line of result.stdout.split('\n')) {
                const cap = line.match(/workflow: captured (\S+) = (.+)/);
                if (cap) {
                    this._applyWorkflowCapture(session, cap[1], cap[2]);
                    continue;
                }
                const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): (.+)/);
                if (errMatch) {
                    session.status = 'Failed';
                    session.errorMessage = `${errMatch[1]}: ${errMatch[2].trim()}`;
                }
            }
        } catch {
            // SSH error — skip this cycle
        }
    }

    /**
     * Check if linkspan is alive by hitting /api/v1/health through the tunnel.
     */
    private async _checkLinkspanHealth(session: Runtime): Promise<boolean> {
        if (!session.tunnelUrl) { return false; }
        try {
            const baseUrl = session.tunnelUrl.replace(/\/$/, '');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(`${baseUrl}/api/v1/health`, {
                signal: controller.signal,
                headers: session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {},
            });
            clearTimeout(timeout);
            return resp.ok;
        } catch {
            return false;
        }
    }

    /**
     * Fetch linkspan's /api/v1/status endpoint through the tunnel.
     */
    private async _pollLinkspanStatus(session: Runtime): Promise<boolean> {
        try {
            const baseUrl = session.tunnelUrl!.replace(/\/$/, '');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(`${baseUrl}/api/v1/status`, {
                signal: controller.signal,
                headers: session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {},
            });
            clearTimeout(timeout);
            if (!resp.ok) { return false; }
            const status: any = await resp.json();
            // Apply captured outputs
            for (const [varName, value] of Object.entries(status.outputs)) {
                this._applyWorkflowCapture(session, varName, String(value));
            }
            // Handle workflow failure
            if (status.state === 'failed' && status.error) {
                session.status = 'Failed';
                session.errorMessage = status.error;
            }
            this._outputChannel.appendLine(`[poll] linkspan status: ${status.state} (step ${status.currentStep}/${status.totalSteps}${status.stepName ? ` — ${status.stepName}` : ''})`);
            return true;
        } catch {
            return false;
        }
    }

    private _clusterInfoDir(): string {
        const dir = path.join(os.homedir(), '.cybershuttle', 'cluster-info');
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
        return dir;
    }

    private _loadCachedClusterInfo(hostName: string): { partitions: any; remoteHome?: string; fetchedAt: number } | null {
        try {
            const filePath = path.join(this._clusterInfoDir(), `${hostName}.json`);
            if (!fs.existsSync(filePath)) { return null; }
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch { return null; }
    }

    private _saveCachedClusterInfo(hostName: string, partitions: any, remoteHome?: string) {
        try {
            const filePath = path.join(this._clusterInfoDir(), `${hostName}.json`);
            const tmpPath = filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify({ partitions, remoteHome, fetchedAt: Date.now() }, null, 2));
            fs.renameSync(tmpPath, filePath);
        } catch { /* best effort */ }
    }

    /**
     * Query SLURM partition and account info for the current user on a remote host
     * using scripts/info.sh. Sends a partition→info mapping to the webview
     * to populate the Partition and Allocation dropdowns.
     * Serves cached data immediately if available, then refreshes in background.
     */
    private async queryAssociations(hostName: string) {
        // Serve cached data immediately if available
        const cached = this._loadCachedClusterInfo(hostName);
        if (cached && cached.partitions && Object.keys(cached.partitions).length > 0) {
            if (cached.remoteHome) { this._cachedRemoteHome.set(hostName, cached.remoteHome); }
            const savedPrefs = this._getHostPrefs(hostName);
            this._postSessionsMessage({ type: 'associations', host: hostName, partitions: cached.partitions, savedPrefs });
        }

        // Cancel any in-flight fetch for this host
        const prev = this._associationsCts.get(hostName);
        if (prev) { prev.cancel(); }

        const cts = new vscode.CancellationTokenSource();
        this._associationsCts.set(hostName, cts);

        const hasCached = cached && cached.partitions && Object.keys(cached.partitions).length > 0;

        await vscode.window.withProgress({
            location: hasCached ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
            title: `Querying cluster info on ${hostName}`,
            cancellable: true,
        }, async (progress, progressToken) => {
            // Merge: cancel if either the toast Cancel or webview Stop fires
            const mergedDisposable = progressToken.onCancellationRequested(() => cts.cancel());
            const token = cts.token;

            this._outputChannel.appendLine(`\n--- Querying SLURM partition info on ${hostName} ---`);
            progress.report({ message: 'Fetching partitions and accounts...' });

            try {
                const infoScript = fs.readFileSync(
                    path.join(this._extensionUri.fsPath, 'scripts', 'info.sh'),
                    'utf-8'
                );
                const result = await this._ssh.runRemoteCommand(
                    hostName,
                    '',
                    token,
                    `echo "HOMEDIR:$HOME"\n` + infoScript + '\nexit 0\n'
                );

                this._outputChannel.appendLine(`info.sh exit code: ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(`info.sh stderr: ${result.stderr}`);
                }

                if (result.code === 0) {
                    this._outputChannel.appendLine(`info.sh stdout: [${result.stdout}]`);

                    const lines = result.stdout.trim().split('\n');

                    // Extract remote home directory from first line
                    const homeLine = lines.find((l: string) => l.startsWith('HOMEDIR:'));
                    if (homeLine) {
                        const remoteHome = homeLine.slice('HOMEDIR:'.length).trim();
                        if (remoteHome) {
                            this._cachedRemoteHome.set(hostName, remoteHome);
                            this._outputChannel.appendLine(`Remote home for ${hostName}: ${remoteHome}`);
                        }
                    }
                    const partitions: { [name: string]: { accounts: string[]; nodes: number; maxCpus: number; maxMemMb: number; maxGpus: number; gpuTypes: string[] } } = {};

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (!line || line.startsWith('partition|')) { continue; }
                        const parts = line.split('|');
                        // 7-column format: partition|nodes|max_cpus|max_mem_mb|max_gpus|gpu_types|accounts
                        if (parts.length >= 7) {
                            const name = parts[0].trim();
                            const nodes = parseInt(parts[1].trim(), 10) || 0;
                            const maxCpus = parseInt(parts[2].trim(), 10) || 0;
                            const maxMemMb = parseInt(parts[3].trim(), 10) || 0;
                            const maxGpus = parseInt(parts[4].trim(), 10) || 0;
                            const gpuTypes = parts[5].trim()
                                ? parts[5].trim().split(',').filter((t: string) => t.length > 0) : [];
                            const accounts = parts[6].trim()
                                ? parts[6].trim().split(',').filter((a: string) => a.length > 0) : [];
                            // Validate: partition name must be alphanumeric/hyphens/underscores, nodes > 0
                            if (name && /^[a-zA-Z0-9_-]+$/.test(name) && nodes > 0) {
                                partitions[name] = { accounts, nodes, maxCpus, maxMemMb, maxGpus, gpuTypes };
                            }
                        }
                    }

                    // Fallback: if info.sh produced no partition rows, get basic list from sinfo
                    if (Object.keys(partitions).length === 0) {
                        this._outputChannel.appendLine('No partitions from info.sh, falling back to sinfo');
                        const fallback = await this._ssh.runRemoteCommand(
                            hostName,
                            '',
                            token,
                            `sinfo -h -o "%P %D %c" 2>/dev/null | sed 's/*//g'\nexit 0\n`
                        );
                        this._outputChannel.appendLine(`Fallback sinfo exit code: ${fallback.code}`);
                        this._outputChannel.appendLine(`Fallback sinfo stdout: [${fallback.stdout}]`);
                        if (fallback.stderr) {
                            this._outputChannel.appendLine(`Fallback sinfo stderr: ${fallback.stderr}`);
                        }
                        if (fallback.code === 0 && fallback.stdout.trim()) {
                            for (const line of fallback.stdout.trim().split('\n')) {
                                const cols = line.trim().split(/\s+/);
                                if (cols.length >= 3 && cols[0]) {
                                    partitions[cols[0]] = {
                                        accounts: [],
                                        nodes: parseInt(cols[1], 10) || 0,
                                        maxCpus: parseInt(cols[2], 10) || 0,
                                        maxMemMb: 0,
                                        maxGpus: 0,
                                        gpuTypes: [],
                                    };
                                }
                            }
                        }
                        this._outputChannel.appendLine(`Fallback parsed ${Object.keys(partitions).length} partitions`);
                    }

                    progress.report({ message: 'Done.' });
                    this._saveCachedClusterInfo(hostName, partitions, this._cachedRemoteHome.get(hostName));
                    const savedPrefs = this._getHostPrefs(hostName);
                    this._postSessionsMessage({ type: 'associations', host: hostName, partitions, savedPrefs });
                } else {
                    this._outputChannel.appendLine(`Command exited with code ${result.code}`);
                    if (result.stderr) {
                        this._outputChannel.appendLine(result.stderr);
                    }
                    this._postSessionsMessage({ type: 'associationsError', host: hostName, error: result.stderr || `exit code ${result.code}` });
                }
                this._outputChannel.appendLine(`--- End of partition info ---\n`);
            } catch (err: any) {
                if (err.cancelled) {
                    this._outputChannel.appendLine('Partition query cancelled by user');
                    this._postSessionsMessage({ type: 'associationsCancelled', host: hostName });
                } else {
                    this._outputChannel.appendLine(`Error: ${err.message}`);
                    this._postSessionsMessage({ type: 'associationsError', host: hostName, error: err.message });
                }
            } finally {
                mergedDisposable.dispose();
                this._associationsCts.delete(hostName);
            }
        });
    }

    /**
     * Connect to an SSH host using VS Code Remote-SSH
     */
    private async connectToSshHost(hostName: string) {
        // Find matching session for this host to save context
        const matchedSession = this._allRuntimes().find(
            s => !s.isLocal && s.host === hostName && s.status === 'Active'
        );

        // Use saved remote path or prompt for one
        let remotePath = matchedSession?.connectedRemotePath;
        if (!remotePath) {
            // Use cached home from queryAssociations, fall back to /
            const defaultPath = this._cachedRemoteHome.get(hostName) || '/';

            remotePath = await vscode.window.showInputBox({
                title: `Connect to ${hostName}`,
                prompt: 'Enter the remote folder path',
                placeHolder: defaultPath,
                value: defaultPath,
            });
        }

        if (remotePath) {
            // Save workspace context on the matched session
            if (matchedSession) {
                matchedSession.localWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                matchedSession.connectedRemotePath = remotePath;
                this._saveSessions();
            }

            vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.from({
                    scheme: 'vscode-remote',
                    authority: `ssh-remote+${hostName}`,
                    path: remotePath,
                }),
                true // Open in new window
            );
        }
    }

    /**
     * Switch the current window to the remote session.
     * For local sessions, connects via ssh-remote+cs-tunnel-{id}.
     * For remote sessions with compute node SSH, sets up port forwarding
     * through the login node and connects via ssh-remote+cs-session-{id}.
     * For remote sessions without compute node info, connects via ssh-remote+{host}.
     */
    private async switchToRemote(sessionId: string) {
        const session = this._findRuntime(sessionId)?.runtime;
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
                const localInfo = this._localLinkspan.get(session.localWorkdir);
                if (!localInfo?.tunnelId) {
                    vscode.window.showErrorMessage('Local linkspan is not running. Start it first via the Sessions panel or "CyberShuttle: Start Linkspan" command.');
                    return;
                }
            }
            session.switchOnReady = true;
            session.status = 'Submitting';
            this._saveSessions();
            this._sendRuntimeUpdates();
            try {
                const creds = await this.tunnelManager.getCredentials();
                const localInfo = session.localWorkdir ? this._localLinkspan.get(session.localWorkdir) : undefined;
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
                    authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, ...localParams,
                });
                session.script = script;
                await this.submitJob(session.id);
            } catch (err: any) {
                session.status = 'Failed';
                session.errorMessage = err.message;
                session.switchOnReady = false;
                this._saveSessions();
                this._sendRuntimeUpdates();
            }
            return;
        }
        // If runtime is active but has no tunnel (stale), re-launch it
        const isStaleActive = session.status === 'Active' && !session.tunnelUrl;
        if (session.slurmJobId && isStaleActive) {
            // Require local linkspan to be running before re-launching
            if (session.localWorkdir) {
                const localInfo = this._localLinkspan.get(session.localWorkdir);
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
            this._saveSessions();
            this._sendRuntimeUpdates();
            try {
                const creds = await this.tunnelManager.getCredentials();
                const localInfo = session.localWorkdir ? this._localLinkspan.get(session.localWorkdir) : undefined;
                const localParams = {
                    localTunnelId: localInfo?.tunnelId,
                    localTunnelToken: localInfo?.tunnelToken,
                    localSshPort: localInfo?.sshPort,
                    localWorkspace: session.localWorkdir,
                };
                const script = this.generateSlurmScript({
                    cpus: session.cpus, memory: session.memory, gpu: session.gpu,
                    wallTime: session.wallTime, queue: session.queue, allocation: session.allocation,
                    authToken: creds.authToken, provider: creds.provider, serverUrl: creds.serverUrl, sessionId: session.id, host: session.host, ...localParams,
                });
                session.script = script;
                await this.submitJob(session.id);
            } catch (err: any) {
                session.status = 'Failed';
                session.errorMessage = err.message;
                session.switchOnReady = false;
                this._saveSessions();
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
        this._switchingSessionId = sessionId;
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
                if (!remotePath) {
                    if (session.isLocal && session.localWorkdir) {
                        remotePath = `${os.homedir()}/sessions/${sessionId}`;
                    } else {
                        remotePath = this._cachedRemoteHome.get(session.host) || '~/sessions/' + sessionId;
                    }
                    session.connectedRemotePath = remotePath;
                }
                this._saveSessions();
                progress.report({ message: 'Opening remote folder...' });
                if (session.isLocal) {
                    // Local sessions: connect via SSH on localhost
                    const hostAlias = `cs-tunnel-${sessionId}`;
                    if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshPort!, 'user')) {
                        return;
                    }
                    this._outputChannel.appendLine(`[switch] Opening remote folder: scheme=vscode-remote, authority=ssh-remote+${hostAlias}, path=${remotePath}`);
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${hostAlias}`,
                        path: remotePath,
                    }), { forceNewWindow: false });
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
                                this._outputChannel.appendLine(`[preflight] SSH port ${session.sshPort} not in port map`);
                                return false;
                            }
                            session.sshTunnelLocalPort = localSshPort;
                            this._saveSessions();
                            // Auto-start log streaming if log port is available
                            if (session.logPort && !this._logTailProcesses.has(sessionId)) {
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
                            if (!healthy) {
                                this._outputChannel.appendLine(`[preflight] Linkspan health check failed, falling back to SSH`);
                                await this._checkJobViaSsh(session);
                                if (session.status === 'Failed' || session.status === 'Completed') {
                                    vscode.window.showErrorMessage('The remote job has ended. Cannot connect.');
                                    return;
                                }
                            }
                            this._outputChannel.appendLine(`[preflight] Linkspan is healthy`);
                        } else {
                            try {
                                await this._checkJobViaSsh(session);
                                if (session.status === 'Failed' || session.status === 'Completed') {
                                    vscode.window.showErrorMessage('The remote job has ended. Cannot connect.');
                                    return;
                                }
                                this._outputChannel.appendLine(`[preflight] Job ${session.slurmJobId} is still running`);
                            } catch (err: any) {
                                this._outputChannel.appendLine(`[preflight] Failed to check job status: ${err.message}`);
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
                        this._outputChannel.appendLine(`[preflight] TCP probe to 127.0.0.1:${session.sshTunnelLocalPort} failed, reconnecting tunnel`);
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
                    this._outputChannel.appendLine(`[preflight] TCP probe to 127.0.0.1:${session.sshTunnelLocalPort} succeeded`);
                    // --- Write SSH config ---
                    if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshTunnelLocalPort!, 'user')) {
                        return;
                    }
                    // --- SSH options reused across all preflight commands ---
                    const sshOpts = `-o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
                    // Use ControlMaster to multiplex all preflight SSH over one TCP connection
                    const ctlArgs = this._ssh.getControlMasterArgs(hostAlias).join(' ');
                    // --- Verify SSH + resolve ~ in a single round trip ---
                    progress.report({ message: 'Verifying SSH to compute node...' });
                    try {
                        const combined = execSync(
                            `ssh ${sshOpts} ${ctlArgs} ${hostAlias} "echo __CS_SSH_OK__ && echo HOME_IS=\\$HOME"`,
                            { encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] }
                        ).trim();
                        if (!combined.includes('__CS_SSH_OK__')) {
                            this._outputChannel.appendLine(`[preflight] SSH check returned unexpected output: ${combined}`);
                            vscode.window.showErrorMessage('SSH to compute node responded but returned unexpected output. Check the output channel.');
                            return;
                        }
                        this._outputChannel.appendLine('[preflight] SSH to compute node verified');
                        const homeMatch = combined.match(/HOME_IS=(.+)/);
                        if (homeMatch && homeMatch[1].startsWith('/') && remotePath!.startsWith('~')) {
                            remotePath = remotePath!.replace(/^~/, homeMatch[1].trim());
                            session.connectedRemotePath = remotePath;
                            this._saveSessions();
                        }
                    } catch (err: any) {
                        this._outputChannel.appendLine(`[preflight] SSH check failed: ${err.message}`);
                        vscode.window.showErrorMessage('Cannot SSH to compute node through tunnel. The remote session may have ended or SSH is not ready yet.');
                        return;
                    }
                    // --- Wait for remote linkspan + verify workspace in single poll ---
                    if (session.slurmJobId) {
                        progress.report({ message: 'Waiting for remote workspace...' });
                        const logPrefix = session.noSlurm ? 'linkspan-plain-' : 'linkspan-session-';
                        const logId = session.noSlurm ? session.slurmJobId.replace('pid-', '') : session.slurmJobId;
                        const logFile = `$HOME/.cybershuttle/logs/${logPrefix}${logId}.err`;
                        const maxWait = 60;
                        let linkspanReady = false;
                        for (let i = 0; i < maxWait; i++) {
                            // Single SSH command checks success, errors, and workspace dir
                            try {
                                const pollScript = `OK=$(grep -c 'finished successfully' ${logFile} 2>/dev/null || echo 0); ERR=$(grep -c 'workflow step' ${logFile} 2>/dev/null || echo 0); DIR=$(test -d '${remotePath}' && echo Y || echo N); echo OK=$OK ERR=$ERR DIR=$DIR`;
                                const poll = execSync(
                                    `ssh ${sshOpts} ${ctlArgs} ${hostAlias} sh -c ${JSON.stringify(pollScript)}`,
                                    { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
                                ).trim();
                                this._outputChannel.appendLine(`[switch] Poll: ${poll}`);
                                const okMatch = poll.match(/OK=(\d+)/);
                                const errMatch = poll.match(/ERR=(\d+)/);
                                if (okMatch && parseInt(okMatch[1], 10) > 0) {
                                    this._outputChannel.appendLine(`[switch] Remote linkspan finished after ${i * 2}s`);
                                    linkspanReady = true;
                                    // Check workspace dir from the same response
                                    if (poll.includes('DIR=N')) {
                                        this._outputChannel.appendLine(`[preflight] Remote workspace directory ${remotePath} does not exist`);
                                        vscode.window.showErrorMessage(`Remote workspace directory does not exist: ${remotePath}`);
                                        return;
                                    }
                                    break;
                                }
                                if (errMatch && parseInt(errMatch[1], 10) > 0) {
                                    this._outputChannel.appendLine('[switch] Remote linkspan has errors');
                                    try {
                                        const tail = execSync(
                                            `ssh ${sshOpts} ${ctlArgs} ${hostAlias} sh -c ${JSON.stringify(`tail -5 ${logFile} 2>/dev/null`)}`,
                                            { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
                                        ).trim();
                                        this._outputChannel.appendLine(`[switch] Remote linkspan tail:\n${tail}`);
                                    } catch { /* ignore */ }
                                }
                            } catch { /* not ready yet */ }
                            if (i === maxWait - 1) {
                                this._outputChannel.appendLine('[switch] Timed out waiting for remote linkspan');
                            }
                            await new Promise(r => setTimeout(r, 2000));
                        }
                        if (!linkspanReady) {
                            vscode.window.showErrorMessage('Remote workspace setup timed out. The remote linkspan may have failed. Check the Cybershuttle output channel.');
                            return;
                        }
                    }
                    // Inject .vscode/settings.json in a single SSH command
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
                        // Single SSH: mkdir + write settings in one connection
                        execSync(
                            `ssh ${sshOpts} ${ctlArgs} ${hostAlias} sh -c ${JSON.stringify(`mkdir -p '${remotePath}/.vscode' && cat > '${remotePath}/.vscode/settings.json'`)}`,
                            { input: remoteSettings, timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
                        );
                        this._outputChannel.appendLine('[switch] Injected remote .vscode/settings.json');
                    } catch (err: any) {
                        this._outputChannel.appendLine(`[switch] Failed to inject remote settings: ${err.message}`);
                    }
                    this._outputChannel.appendLine(`[switch] Opening remote folder: scheme=vscode-remote, authority=ssh-remote+${hostAlias}, path=${remotePath}`);
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${hostAlias}`,
                        path: remotePath!,
                    }), { forceNewWindow: false });
                } else {
                    // Remote sessions without compute node: connect to login node
                    this._outputChannel.appendLine(`[switch] Opening remote folder: scheme=vscode-remote, authority=ssh-remote+${session.host}, path=${remotePath}`);
                    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${session.host}`,
                        path: remotePath!,
                    }), { forceNewWindow: false });
                }
            });
        } finally {
            this._switchingSessionId = undefined;
            this._sendRuntimeUpdates();
        }
    }

    /**
     * Switch back to the local workspace folder from a remote session.
     */
    private async switchToLocal(sessionId: string) {
        const session = this._findRuntime(sessionId)?.runtime;
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
        const found = this._findRuntime(sessionId);
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
        const activeSession = this._detectActiveSession();
        const allRuntimes = this._allRuntimes();
        if (allRuntimes.length === 0) {
            vscode.window.showInformationMessage('No sessions available.');
            return;
        }
        const items: (vscode.QuickPickItem & { _sessionId: string; _isLocal: boolean; _isRemote: boolean })[] = [];
        for (const rt of allRuntimes) {
            let description = rt.host;
            let detail = '';
            const isCurrent = activeSession?.id === rt.id || (rt.status === 'Local' && rt.windowId === this._windowId);
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
        const found = session ? this._findRuntime(session.id) : undefined;
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
        this._outputChannel.appendLine(`[session] ${reason} — prompting switch to local (${localPath})`);
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
        try {
            await this.ensureLocalLinkspan();
            await this._localLinkspan.ensure(workspacePath);
            this._outputChannel.appendLine('[linkspan-local] Auto-started successfully');
            this._sendRuntimeUpdates();
        } catch (err: any) {
            this._outputChannel.appendLine(`[linkspan-local] Auto-start failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}`);
            if (attempt < MAX_RETRIES) {
                const delay = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
                setTimeout(() => this._autoStartLinkspan(attempt + 1), delay);
            }
        }
    }

    async startLocalLinkspan(): Promise<void> {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspacePath) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        // Immediate UI feedback — mark as starting
        this._linkspanStartingPath = workspacePath;
        this.refreshSessionsView();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Starting Linkspan',
            cancellable: false,
        }, async (progress) => {
            try {
                progress.report({ message: 'Downloading latest linkspan...' });
                await this.ensureLocalLinkspan();
                progress.report({ message: 'Starting...' });
                await this._localLinkspan.ensure(workspacePath);
                const info = this._localLinkspan.get(workspacePath);
                if (info) {
                    this._outputChannel.appendLine(`[linkspan-local] Started: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}`);
                }
                vscode.window.showInformationMessage('Linkspan started');
            } catch (err: any) {
                this._outputChannel.appendLine(`[linkspan-local] Start failed: ${err.message}`);
                vscode.window.showErrorMessage(`Linkspan start failed: ${err.message}`);
            } finally {
                this._linkspanStartingPath = undefined;
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
        this._linkspanStartingPath = workspacePath;
        this.refreshSessionsView();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Restarting Linkspan',
            cancellable: false,
        }, async (progress) => {
            try {
                progress.report({ message: 'Downloading latest linkspan...' });
                await this.ensureLocalLinkspan();
                progress.report({ message: 'Stopping current instance...' });
                this._localLinkspan.stop(workspacePath);
                progress.report({ message: 'Starting fresh instance...' });
                await this._localLinkspan.ensure(workspacePath);
                const info = this._localLinkspan.get(workspacePath);
                if (info) {
                    this._outputChannel.appendLine(`[linkspan-local] Restarted: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}`);
                }
                vscode.window.showInformationMessage('Linkspan restarted with latest version');
            } catch (err: any) {
                this._outputChannel.appendLine(`[linkspan-local] Restart failed: ${err.message}`);
                vscode.window.showErrorMessage(`Linkspan restart failed: ${err.message}`);
            } finally {
                this._linkspanStartingPath = undefined;
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
        const info = this._localLinkspan.get(workspacePath);
        if (!info) {
            return;
        }
        const activeSessions = this._allRuntimes().filter(
            rt => rt.localWorkdir === workspacePath && rt.status === 'Active' && rt.tunnelId && rt.tunnelToken
        );
        if (activeSessions.length === 0) {
            return;
        }
        this._outputChannel.appendLine(`[linkspan-local] Reconnecting ${activeSessions.length} active session(s) through new linkspan`);
        for (const session of activeSessions) {
            // Clear old connection state — the old linkspan instance is gone
            session.connectionId = undefined;
            session._portMap = undefined;
            session.sshTunnelLocalPort = undefined;
            try {
                const portMap = await this._connectViaTunnel(session.id, session);
                if (portMap) {
                    this._outputChannel.appendLine(`[linkspan-local] Reconnected session ${session.id} (${session.host})`);
                    // Announce the new local linkspan tunnel to the remote linkspan
                    // so it can update its back-connection for FUSE/storage overlay
                    await this._announceLocalLinkspan(session, info);
                } else {
                    this._outputChannel.appendLine(`[linkspan-local] Failed to reconnect session ${session.id} (${session.host})`);
                }
            } catch (err: any) {
                this._outputChannel.appendLine(`[linkspan-local] Reconnect error for ${session.id}: ${err.message}`);
            }
        }
        this._saveSessions();
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
                this._outputChannel.appendLine(`[linkspan-local] Announced local linkspan to remote ${session.id} (${session.host})`);
            } else {
                this._outputChannel.appendLine(`[linkspan-local] Announce failed for ${session.id}: ${resp.status} ${await resp.text()}`);
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`[linkspan-local] Announce failed for ${session.id}: ${err.message}`);
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
        for (const session of this._allRuntimes()) {
            if (session.localWorkdir === workspacePath && session.connectionId) {
                session.connectionId = undefined;
                session._portMap = undefined;
            }
        }
        this._localLinkspan.stop(workspacePath);
        this._saveSessions();
        this._outputChannel.appendLine(`[linkspan-local] Stopped for ${workspacePath}`);
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
                await this.ensureLocalLinkspan();
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
                await this.tunnelManager.ensureDevTunnel();
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
                await this._dataCache.ensureMutagen();
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
            this._outputChannel.appendLine(`[deps] ${msg}`);
        });
    }

    /**
     * Run a command on a remote SSH host.
     * Handles SSH_ASKPASS IPC for password/passphrase prompts and ControlMaster multiplexing.
     * Returns a promise that resolves with { stdout, stderr, code }.
     */
    private runRemoteCommand(hostName: string, command: string, token?: vscode.CancellationToken, stdinData?: string): Promise<{ stdout: string; stderr: string; code: number }> {
        const cmdStart = Date.now();
        return new Promise((resolve, reject) => {
            // Create a temp directory for askpass IPC
            const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
            const cancelFile = path.join(sessionDir, 'cancel');

            // Path to our askpass helper script
            const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');

            const useStdin = stdinData !== undefined;
            const sshArgs = [
                ...this.getControlMasterArgs(hostName),
                '-o', 'NumberOfPasswordPrompts=3',
                hostName,
                ...(useStdin ? [] : [command]),
            ];

            const sshProcess = spawn('ssh', sshArgs, {
                env: {
                    ...process.env,
                    SSH_ASKPASS: askpassScript,
                    SSH_ASKPASS_REQUIRE: 'force',
                    CS_ASKPASS_DIR: sessionDir,
                    DISPLAY: ':0',
                },
                stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            });

            if (useStdin) {
                sshProcess.stdin!.write(stdinData);
                sshProcess.stdin!.end();
            }

            let stdoutData = '';
            let stderrData = '';
            let disposed = false;
            let cancelled = false;

            // Cancel listener — kill SSH process when token fires
            const cancelListener = token?.onCancellationRequested(() => {
                cancelled = true;
                sshProcess.kill();
            });
            const handledPrompts = new Set<string>();

            sshProcess.stdout!.on('data', (data: Buffer) => {
                stdoutData += data.toString();
            });

            sshProcess.stderr!.on('data', (data: Buffer) => {
                stderrData += data.toString();
            });

            // Poll for prompt-* files from the askpass script
            const pollInterval = setInterval(async () => {
                if (disposed) {
                    return;
                }

                try {
                    const files = fs.readdirSync(sessionDir);
                    for (const file of files) {
                        if (!file.startsWith('prompt-') || handledPrompts.has(file)) {
                            continue;
                        }

                        handledPrompts.add(file);

                        const promptFilePath = path.join(sessionDir, file);
                        const content = fs.readFileSync(promptFilePath, 'utf-8');
                        const { id, prompt } = JSON.parse(content);
                        const responseFile = path.join(sessionDir, `response-${id}`);

                        const password = await vscode.window.showInputBox({
                            title: `SSH Authentication — ${hostName}`,
                            prompt: prompt.trim(),
                            password: true,
                            ignoreFocusOut: true,
                        });

                        if (password !== undefined) {
                            fs.writeFileSync(responseFile, password, 'utf-8');
                        } else {
                            fs.writeFileSync(cancelFile, '', 'utf-8');
                            sshProcess.kill();
                        }
                    }
                } catch {
                    // Ignore file access errors during polling
                }
            }, 200);

            const cleanup = () => {
                disposed = true;
                clearInterval(pollInterval);
                cancelListener?.dispose();
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            };

            sshProcess.on('close', (code: number | null) => {
                cleanup();
                const duration = Date.now() - cmdStart;
                if (cancelled) {
                    const err: any = new Error('Operation cancelled');
                    err.cancelled = true;
                    this._metrics.record('ssh_connect', 'failure', { target_host: this._resolveHostname(hostName) }, duration, 'Cancelled');
                    reject(err);
                } else {
                    this._metrics.record('ssh_connect', (code ?? 1) === 0 ? 'success' : 'failure', { target_host: this._resolveHostname(hostName) }, duration, code !== 0 ? `exit code ${code}` : undefined);
                    resolve({ stdout: stdoutData, stderr: stderrData, code: code ?? 1 });
                }
            });

            sshProcess.on('error', (err: Error) => {
                cleanup();
                this._metrics.record('ssh_connect', 'failure', { target_host: this._resolveHostname(hostName) }, Date.now() - cmdStart, err.message);
                reject(err);
            });
        });
    }

    /**
     * Fetch a remote file's content and open it in a VS Code editor tab.
     */
    private async openRemoteFile(hostName: string, remotePath: string) {
        try {
            const result = await this._runShellCommand(hostName, `cat "${remotePath.replace(/"/g, '\\"')}"`);
            if (result.code !== 0) {
                vscode.window.showErrorMessage(`Failed to read file: exit code ${result.code}`);
                return;
            }

            const fileName = remotePath.split('/').pop() || 'untitled';
            const pathHash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
            const tmpDir = path.join(os.tmpdir(), 'cybershuttle-files');
            if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
            const tmpFile = path.join(tmpDir, `${hostName}-${pathHash}-${fileName}`);
            fs.writeFileSync(tmpFile, result.stdout);

            const doc = await vscode.workspace.openTextDocument(tmpFile);
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open remote file: ${err.message}`);
        }
    }


    /**
     * Refresh the Sessions webview content.
     */
    refreshSessionsView() {
        if (this._disposing) { return; }
        if (this._sessionsView) {
            try {
                this._sessionsView.webview.html = this._getSessionsHtml(this._sessionsView.webview);
                // Immediately push real data to replace loading skeletons
                this._sendRuntimeUpdates();
            } catch (err: any) {
                this._outputChannel.appendLine(`[webview] Failed to render sessions: ${err.message}`);
            }
        }
    }

    /**
     * Refresh the Storages webview content.
     */
    refreshStorages() {
        if (this._storagesView) {
            try {
                this._storagesView.webview.html = this._getStoragesHtml(this._storagesView.webview);
            } catch (err: any) {
                this._outputChannel.appendLine(`[webview] Failed to render storages: ${err.message}`);
            }
        }
    }

    /**
     * Send incremental runtime status updates to the workspaces webview
     * without replacing the entire HTML. Preserves host picker state,
     * form values, and scroll position.
     */
    private _sendRuntimeUpdates() {
        if (this._disposing) { return; }
        const activeSession = this._detectActiveSession();
        const visibleWorkspaces = this._getVisibleWorkspaces(activeSession);
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
                    const info = this._localLinkspan.get(ws.directoryPath);
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
                    ? this._linkspanStartingPath === ws.directoryPath
                    : false;

                return {
                    id: rt.id,
                    status: rt.status,
                    host: rt.host,
                    isLocal: !!rt.isLocal,
                    windowId: rt.windowId,
                    isActiveInThisWindow: activeSession?.id === rt.id,
                    isThisWindow: rt.status === 'Local' && rt.windowId === this._windowId,
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
                    switching: rt.id === this._switchingSessionId || !!rt.switchOnReady,
                    linkspanInfo,
                    linkspanStarting,
                };
            }),
        }));
        // Check if any workspace has a running linkspan
        const linkspanRunning = visibleWorkspaces.some(ws => ws.directoryPath && !!this._localLinkspan.get(ws.directoryPath));
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
        const session = this._detectActiveSession();
        if (!session || session.status === 'Local' || session.status !== 'Active') {
            this._statusBarItem.hide();
            if (this._countdownTimer) {
                clearInterval(this._countdownTimer);
                this._countdownTimer = undefined;
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
                this._statusBarItem.text = `$(warning) ${session.host} — expired | ${meta}`;
                this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            } else {
                const totalSec = Math.floor(remaining / 1000);
                const hrs = Math.floor(totalSec / 3600);
                const mins = Math.floor((totalSec % 3600) / 60);
                const secs = totalSec % 60;
                const pad = (n: number) => String(n).padStart(2, '0');
                const countdown = hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
                this._statusBarItem.text = `$(remote) ${session.host} — ${countdown} remaining | ${meta}`;
                const totalMin = totalSec / 60;
                if (totalMin <= 5) {
                    this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                } else if (totalMin <= 15) {
                    this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                } else {
                    this._statusBarItem.backgroundColor = undefined;
                }
            }
            this._statusBarItem.tooltip = `CyberShuttle session on ${session.host}\nJob: ${session.slurmJobId || 'local'}\nResources: ${session.cpus} vCPU, ${session.memory}${gpu}\nQueue: ${session.queue} | Allocation: ${session.allocation}`;
            this._statusBarItem.show();
        };

        updateText();
        if (this._countdownTimer) { clearInterval(this._countdownTimer); }
        this._countdownTimer = setInterval(updateText, 1000);
    }

    /**
     * Build shared CSS styles used by both webviews.
     */
    private _getCommonStyles(codiconsFontUri: vscode.Uri): string {
        return `
        @font-face {
            font-family: "codicon";
            font-display: block;
            src: url("${codiconsFontUri}") format("truetype");
        }
        `;
    }

    /**
     * Generate the HTML for the INFO webview — static Account + Path display.
     */
    private _getInfoHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.ttf'));
        const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.css'));
        const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'common.css'));
        const infoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'info.css'));

        const activeSession = this._detectActiveSession();
        const visibleWorkspaces = this._getVisibleWorkspaces(activeSession);
        const ws = visibleWorkspaces[0];
        let displayPath = '';
        if (ws) {
            displayPath = ws.directoryPath.startsWith(os.homedir())
                ? '~' + ws.directoryPath.slice(os.homedir().length)
                : ws.directoryPath;
        } else if (vscode.workspace.workspaceFolders?.[0]) {
            const folder = vscode.workspace.workspaceFolders[0];
            const fsPath = folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString();
            displayPath = fsPath.startsWith(os.homedir())
                ? '~' + fsPath.slice(os.homedir().length)
                : fsPath;
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Info</title>
    <link rel="stylesheet" href="${codiconsCssUri}">
    <link rel="stylesheet" href="${commonCssUri}">
    <link rel="stylesheet" href="${infoCssUri}">
    <style>
        ${this._getCommonStyles(codiconsFontUri)}
    </style>
</head>
<body>
    <div id="account-line" class="info-line">
        <span class="info-label">Account:</span>
        <span id="account-value" class="info-value ${this.tunnelManager.devTunnelAccount ? '' : 'info-value-warn'}">${this.tunnelManager.devTunnelAccount ? escapeHtml(this.tunnelManager.devTunnelAccount) : 'Not signed in'}</span>
        ${this.tunnelManager.devTunnelAccount
            ? '<button id="auth-switch-btn" class="info-action-btn">Switch</button>'
            : '<button id="auth-sign-in-btn" class="info-action-btn">Sign In</button>'}
    </div>
    ${displayPath ? `
    <div class="info-line">
        <span class="info-label">Path:</span>
        <span class="info-value info-value-mono">${escapeHtml(displayPath)}</span>
    </div>` : ''}
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        function bindButtons() {
            const signIn = document.getElementById('auth-sign-in-btn');
            if (signIn) signIn.addEventListener('click', () => vscode.postMessage({ type: 'devTunnelSignIn' }));
            const switchBtn = document.getElementById('auth-switch-btn');
            if (switchBtn) switchBtn.addEventListener('click', () => vscode.postMessage({ type: 'devTunnelSwitch' }));
        }
        bindButtons();
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'authState') {
                const line = document.getElementById('account-line');
                if (line) {
                    if (msg.account) {
                        line.innerHTML = '<span class="info-label">Account:</span><span id="account-value" class="info-value">' + msg.account + '</span><button id="auth-switch-btn" class="info-action-btn">Switch</button>';
                    } else {
                        line.innerHTML = '<span class="info-label">Account:</span><span id="account-value" class="info-value info-value-warn">Not signed in</span><button id="auth-sign-in-btn" class="info-action-btn">Sign In</button>';
                    }
                    bindButtons();
                }
            }
        });
    </script>
</body>
</html>`;
    }

    /**
     * Generate the HTML for the SESSIONS webview.
     * Contains: workspace cards (sessions + host picker), script preview overlay.
     */
    private _getSessionsHtml(webview: vscode.Webview): string {
        // Use a nonce to only allow a specific script to run
        const nonce = getNonce();

        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.ttf'));
        const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.css'));
        const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'common.css'));
        const sessionsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'sessions', 'sessions.css'));
        const sessionsJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'sessions', 'sessions.js'));

        // Get SSH hosts from config — used for the workspace host picker
        const sshHosts = this.getSshHosts();

        // Build sessions HTML — workspace-grouped cards
        const activeSession = this._detectActiveSession();



        // Helper: build runtime row HTML — renders a loading skeleton.
        // Real data is populated immediately via _sendRuntimeUpdates() + JS incremental handler.
        const buildRuntimeRow = (rt: Runtime, _wsPath?: string): string => {
            const isLocal = !!rt.isLocal;
            const displayName = isLocal ? 'Local' : escapeHtml(rt.host);
            return `
                <div class="runtime-entry status-idle" data-session-id="${escapeHtml(rt.id)}">
                    <div class="runtime-header">
                        <span class="runtime-name">${displayName}</span>
                        <div class="runtime-header-right"></div>
                        <span class="dot-action-wrap"><span class="status-dot dot-idle"></span></span>
                    </div>
                    <div class="runtime-details">
                        <span class="session-detail session-loading-placeholder"><span class="spinner"></span> Loading...</span>
                    </div>
                </div>`;
        };

        // Helper: build the host picker HTML for a workspace
        const buildHostPickerHtml = (ws: Workspace): string => {
            if (sshHosts.length === 0) {
                return '<p class="empty-message" style="margin:8px;">No SSH hosts found in ~/.ssh/config</p>';
            }
            return sshHosts.map(host => `
                <div class="host-picker-item">
                    <div class="host-picker-row" data-host="${escapeHtml(host.name)}" data-workspace-id="${escapeHtml(ws.id)}" title="${host.hostname ? escapeHtml((host.user ? host.user + '@' : '') + host.hostname) : escapeHtml(host.name)}">
                        <span class="host-picker-chevron">&#x203A;</span>
                        <span class="host-picker-name">${escapeHtml(host.name)}</span>
                        ${host.hostname ? `<span class="host-picker-detail">${host.user ? escapeHtml(host.user) + '@' : ''}${escapeHtml(host.hostname)}</span>` : ''}
                    </div>
                    <div class="host-picker-form" id="host-form-${escapeHtml(ws.id)}-${escapeHtml(host.name)}" style="display:none;">
                        <div class="job-form-loading" style="display:none;"><span class="spinner"></span>Fetching partitions...</div>
                        <div class="job-form-error" style="display:none;"><span class="job-form-error-text"></span></div>
                        <div class="job-form-fields" style="display:none;">
                            <div class="resource-tabs" data-host="${escapeHtml(host.name)}">
                                <button class="resource-tab active" data-tab="cpu" data-host="${escapeHtml(host.name)}">CPU</button>
                                <button class="resource-tab" data-tab="gpu" data-host="${escapeHtml(host.name)}" style="display:none;">GPU</button>
                            </div>
                            <div class="form-row alloc-row" data-host="${escapeHtml(host.name)}"><label>Allocation</label><select class="form-select" data-field="allocation" data-host="${escapeHtml(host.name)}">
                                <option value="">Loading...</option>
                            </select></div>
                            <div class="form-row"><label>Partition</label><select class="form-select" data-field="queue" data-host="${escapeHtml(host.name)}">
                                <option value="">Select allocation first</option>
                            </select></div>
                            <div class="form-row"><label>CPUs</label><select class="form-select" data-field="cpus">
                                <option value="1">1</option><option value="2">2</option><option value="4">4</option>
                                <option value="8">8</option><option value="16">16</option><option value="32">32</option><option value="64">64</option>
                            </select></div>
                            <div class="form-row"><label>Memory</label><select class="form-select" data-field="memory">
                                <option value="1 GB">1 GB</option><option value="2 GB">2 GB</option><option value="4 GB">4 GB</option>
                                <option value="8 GB">8 GB</option><option value="16 GB">16 GB</option><option value="32 GB">32 GB</option>
                                <option value="64 GB">64 GB</option><option value="128 GB">128 GB</option>
                            </select></div>
                            <div class="form-row gpu-count-row" style="display:none" data-host="${escapeHtml(host.name)}"><label>GPUs</label><select class="form-select" data-field="gpuCount" data-host="${escapeHtml(host.name)}">
                                <option value="0">None</option>
                            </select></div>
                            <div class="form-row gpu-type-row" style="display:none" data-host="${escapeHtml(host.name)}"><label>GPU Type</label><select class="form-select" data-field="gpuType" data-host="${escapeHtml(host.name)}">
                            </select></div>
                            <div class="form-row"><label>Wall Time</label><select class="form-select" data-field="wallTime">
                                <option value="00:30:00">30 min</option><option value="01:00:00">1 hour</option>
                                <option value="02:00:00">2 hours</option><option value="04:00:00">4 hours</option>
                                <option value="08:00:00">8 hours</option><option value="12:00:00">12 hours</option>
                                <option value="24:00:00">24 hours</option>
                            </select></div>
                            <button class="submit-job-btn" data-host="${escapeHtml(host.name)}" data-workspace-id="${escapeHtml(ws.id)}">Add</button>
                        </div>
                    </div>
                </div>
            `).join('');
        };

        // Only show the workspace matching the currently open folder
        const visibleWorkspaces = this._getVisibleWorkspaces(activeSession);

        // Build sessions HTML
        const sessionsHtml = visibleWorkspaces.length > 0
            ? visibleWorkspaces.map(ws => {
                const sortedRuntimes = [...ws.runtimes].sort((a, b) => {
                    if (a.windowId === this._windowId) { return -1; }
                    if (b.windowId === this._windowId) { return 1; }
                    const statusOrder: Record<string, number> = { Local: 0, Active: 1, Submitting: 2, Pending: 3, Idle: 4, Failed: 5, Completed: 6 };
                    const sa = statusOrder[a.status] ?? 99;
                    const sb = statusOrder[b.status] ?? 99;
                    if (sa !== sb) { return sa - sb; }
                    return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
                });
                // Split runtimes into active (this window) vs others
                const activeRuntimes = sortedRuntimes.filter(rt => rt.isLocal || (activeSession && rt.id === activeSession.id));
                const otherRuntimes = sortedRuntimes.filter(rt => !rt.isLocal && !(activeSession && rt.id === activeSession.id));
                const activeRows = activeRuntimes.map(rt => buildRuntimeRow(rt, ws.directoryPath)).join('');
                const otherRows = otherRuntimes.map(rt => buildRuntimeRow(rt, ws.directoryPath)).join('');
                const hostPickerHtml = buildHostPickerHtml(ws);
                const displayPath = ws.directoryPath.startsWith(os.homedir())
                    ? '~' + ws.directoryPath.slice(os.homedir().length)
                    : ws.directoryPath;
                const activeSection = activeRows ? `<div class="session-group"><div class="session-group-label">Active Session</div><div class="workspace-runtimes">${activeRows}</div></div>` : '';
                const otherSection = otherRows ? `<div class="session-group"><div class="session-group-label">Other Sessions</div><div class="workspace-runtimes">${otherRows}</div></div>` : '';
                return `
                <div class="workspace-section" data-workspace-id="${escapeHtml(ws.id)}">
                    ${activeSection}
                    ${otherSection}
                    <div class="add-session-placeholder" data-workspace-id="${escapeHtml(ws.id)}">
                        <i class="codicon codicon-add"></i> Add Session
                    </div>
                    <div class="workspace-host-picker" id="host-picker-${escapeHtml(ws.id)}" style="display:none;">
                        ${hostPickerHtml}
                    </div>
                </div>`;
            }).join('')
            : vscode.workspace.workspaceFolders?.[0]
                ? '<p class="empty-message">No active sessions</p>'
                : '<p class="empty-message">Open a folder to get started</p>';


        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Sessions</title>
    <link rel="stylesheet" href="${codiconsCssUri}">
    <link rel="stylesheet" href="${commonCssUri}">
    <link rel="stylesheet" href="${sessionsCssUri}">
    <style>
        ${this._getCommonStyles(codiconsFontUri)}
    </style>
</head>
<body>
    <div id="sessions">
        ${sessionsHtml}
    </div>

    <!-- Script preview overlay -->
    <div id="script-preview-overlay" class="script-preview-overlay">
        <div class="script-preview-header">SLURM Job Script Preview</div>
        <div id="script-preview-host" class="script-preview-host"></div>
        <div id="script-preview-code" class="script-preview-code"></div>
        <div class="script-preview-actions">
            <button id="cancel-preview-btn" class="cancel-preview-btn">Cancel</button>
            <button id="confirm-preview-btn">Submit Job</button>
        </div>
    </div>

    <script nonce="${nonce}" src="${sessionsJsUri}"></script>
</body>
</html>`;
    }

    /**
     * Generate the HTML for the FILES webview.
     * Contains: SSH host list as file tree roots, with directory browsing and file opening.
     */
    private _getStoragesHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.ttf'));
        const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.css'));
        const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'common.css'));
        const storagesCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'storages', 'storages.css'));

        const storagesJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'storages', 'storages.js'));

        const sshHosts = this.getSshHosts();
        const browseHost = this._storageBrowser.browseHost;

        // Build breadcrumbs and determine view state
        let breadcrumbsHtml: string;
        let bodyHtml: string;

        if (browseHost) {
            // Browsing inside a host — show breadcrumbs: home / host-name / path / ...
            const current = this._storageBrowser.browseHistory[this._storageBrowser.browseCursor];
            const currentPath = current?.path || '~';
            const segments = currentPath.split('/').filter(Boolean);

            const crumbs = [
                `<span class="breadcrumb-seg breadcrumb-home" data-action="home" title="All hosts"><i class="codicon codicon-home"></i></span>`,
                `<span class="breadcrumb-sep">/</span>`,
                `<span class="breadcrumb-seg breadcrumb-host" data-action="host-root" title="${escapeHtml(browseHost)}">${escapeHtml(browseHost)}</span>`,
            ];
            for (let i = 0; i < segments.length; i++) {
                const segPath = '/' + segments.slice(0, i + 1).join('/');
                crumbs.push(
                    `<span class="breadcrumb-sep">/</span>`,
                    `<span class="breadcrumb-seg" data-path="${escapeHtml(segPath)}">${escapeHtml(segments[i])}</span>`
                );
            }
            breadcrumbsHtml = crumbs.join('');

            bodyHtml = `
                <div class="file-list" id="storages-list">
                    <div class="file-status" id="storages-status"></div>
                </div>`;
        } else {
            // Root view — show SSH hosts as folder entries (like VS Code tunnels list)
            breadcrumbsHtml = `<span class="breadcrumb-seg breadcrumb-home breadcrumb-current" data-action="home"><i class="codicon codicon-home"></i></span><span class="breadcrumb-sep">/</span>`;

            if (sshHosts.length > 0) {
                const entriesHtml = sshHosts.map(host => {
                    const detail = host.hostname
                        ? `${host.user ? escapeHtml(host.user) + '@' : ''}${escapeHtml(host.hostname)}`
                        : '';
                    return `<div class="file-entry dir" data-host="${escapeHtml(host.name)}">
                        <i class="codicon codicon-server"></i>
                        <span class="file-name">${escapeHtml(host.name)}</span>
                        ${detail ? `<span class="file-size">${detail}</span>` : ''}
                    </div>`;
                }).join('');
                bodyHtml = `<div class="file-list" id="storages-host-list">${entriesHtml}</div>`;
            } else {
                bodyHtml = `<div class="file-list"><p class="empty-message">No SSH hosts found in ~/.ssh/config</p></div>`;
            }
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Files</title>
    <link rel="stylesheet" href="${codiconsCssUri}">
    <link rel="stylesheet" href="${commonCssUri}">
    <link rel="stylesheet" href="${storagesCssUri}">
    <style>
        ${this._getCommonStyles(codiconsFontUri)}
    </style>
</head>
<body data-browse-host="${browseHost ? escapeHtml(browseHost) : ''}">
    <div class="file-breadcrumbs">${breadcrumbsHtml}</div>
    ${bodyHtml}

    <script nonce="${nonce}" src="${storagesJsUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function ci(name: string): string {
    return `<i class="codicon codicon-${name}"></i>`;
}

function displayWorkDir(rawPath: string): string {
    if (rawPath === '~' || rawPath.startsWith('~/')) {
        return rawPath === '~' ? '$CS_HOME' : '$CS_HOME/' + rawPath.slice(2);
    }
    return rawPath;
}

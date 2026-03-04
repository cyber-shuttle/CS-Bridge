import * as vscode from 'vscode';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, execSync, ChildProcess } from 'child_process';
import { MetricsCollector } from './instrumentation/index.js';


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
    status: 'Local' | 'Pending' | 'Active' | 'Submitting' | 'Failed' | 'Completed' | 'Idle';
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
    // FUSE mount fields
    localWorkdir?: string;
    fuseMountPid?: number;
    localMountPath?: string;
    remoteMountPath?: string;
    localFuseTunnelUrl?: string;
    remoteFusePort?: number;
    computeNode?: string;
    fuseTunnelPid?: number;
    localFuseServerPid?: number;
    localFuseTunnelId?: string;
    localFuseConnectToken?: string;
    localFusePort?: number;
    // Shared Dev Tunnel connect process (forwards both SSH + FUSE ports from compute node)
    devtunnelConnectPid?: number;
    _devtunnelPortMap?: Map<number, number>; // transient: remotePort → localPort
    // SSH tunnel to compute node (for remote switch)
    sshTunnelPid?: number;
    sshTunnelLocalPort?: number;
}

interface Workspace {
    id: string;
    directoryPath: string;
    directoryName: string;
    runtimes: Runtime[];
}


export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly workspacesViewType = 'cybershuttle.workspacesView';
    public static readonly serversViewType = 'cybershuttle.serversView';

    private _workspacesView?: vscode.WebviewView;
    private _serversView?: vscode.WebviewView;
    private _outputChannel: vscode.OutputChannel;
    private _sshControlDir: string;
    private _workspaces: Workspace[] = [];
    private _expandedHost: string | null = null;
    private _workspaceState: vscode.Memento;
    private _persistentShells: Map<string, PersistentShell> = new Map();
    private _logTailProcesses: Map<string, ChildProcess> = new Map();
    private _browseRequestId: Map<string, number> = new Map();
    private _associationsCts: Map<string, vscode.CancellationTokenSource> = new Map();
    private _cachedAssociations: Map<string, object> = new Map();
    private _localProcesses: Map<string, ChildProcess> = new Map();
    private _devTunnelAccount: string | null = null;
    private _sessionPollTimer?: ReturnType<typeof setInterval>;
    private _sessionPollBusy = false;
    private _sessionsFilePath: string;
    private _lastWriteTime: number = 0;
    private _isRemoteWindow: boolean;
    private _statusBarItem: vscode.StatusBarItem;
    private _countdownTimer?: ReturnType<typeof setInterval>;
    private _disposing = false;
    private _metrics: MetricsCollector;
    private _windowId: string = '';
    private _heartbeatTimer?: ReturnType<typeof setInterval>;

    private static readonly SESSIONS_KEY = 'cybershuttle.jobSessions';

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
        this._isRemoteWindow = folder?.uri.scheme === 'vscode-remote';
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

        // One-time migration from globalState if file is empty/missing
        if (!rawData || (Array.isArray(rawData) && rawData.length === 0)) {
            const legacy = this._workspaceState.get<any[]>(CybershuttleViewProvider.SESSIONS_KEY, []);
            if (legacy.length > 0) {
                rawData = legacy;
                // Write migrated data to file
                try {
                    const tmpPath = this._sessionsFilePath + '.tmp';
                    fs.writeFileSync(tmpPath, JSON.stringify(rawData, null, 2));
                    fs.renameSync(tmpPath, this._sessionsFilePath);
                } catch { /* best effort */ }
                // Clear legacy storage
                this._workspaceState.update(CybershuttleViewProvider.SESSIONS_KEY, undefined);
            }
        }

        if (!rawData) {
            this._workspaces = [];
        } else if (Array.isArray(rawData) && rawData.length > 0 && rawData[0].runtimes !== undefined) {
            // New Workspace[] format
            this._workspaces = rawData.map((ws: any) => ({
                ...ws,
                directoryName: ws.directoryPath === 'unknown' ? 'No Folder' : (ws.directoryName || path.basename(ws.directoryPath) || ws.directoryPath),
                runtimes: (ws.runtimes || []).map((r: any) => ({
                    ...r,
                    submittedAt: new Date(r.submittedAt),
                })),
            }));
        } else if (Array.isArray(rawData)) {
            // Legacy flat Runtime[] format — migrate by grouping by workspacePath
            const flatSessions: any[] = rawData.map((s: any) => ({
                ...s,
                submittedAt: new Date(s.submittedAt),
            }));
            const wsMap = new Map<string, any[]>();
            for (const s of flatSessions) {
                const key = s.workspacePath || s.localWorkspaceFolder || 'unknown';
                if (!wsMap.has(key)) { wsMap.set(key, []); }
                wsMap.get(key)!.push(s);
            }
            this._workspaces = [];
            for (const [dirPath, sessions] of wsMap) {
                const runtimes: Runtime[] = sessions.map((s: any) => ({
                    ...s,
                    type: (s.isLocal || s.status === 'Local') ? 'local' as const : 'remote' as const,
                }));
                this._workspaces.push({
                    id: crypto.randomBytes(4).toString('hex'),
                    directoryPath: dirPath,
                    directoryName: dirPath === 'unknown' ? 'No Folder' : (path.basename(dirPath) || dirPath),
                    runtimes,
                });
            }
        } else {
            this._workspaces = [];
        }

        // Reconcile orphaned local sessions: if the process died (e.g. VS Code
        // was closed), re-launch it so the session survives across restarts.
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
        // Resume polling if any remote sessions are still in non-terminal states
        const needsPoll = this._allRuntimes().some(
            s => s.slurmJobId && !s.isLocal
                && s.status !== 'Failed' && s.status !== 'Completed'
        );
        if (needsPoll) {
            this._startSessionPolling();
        }
    }

    private _saveSessions() {
        try {
            const tmpPath = this._sessionsFilePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(this._workspaces, null, 2));
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
            this._outputChannel.appendLine('[sessions] Sessions file changed externally, reloading');
            this._loadSessions();
            this.refresh();
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
            }
            this._saveSessions();
            return;
        }

        // Only create a new Local runtime for non-remote windows
        if (this._isRemoteWindow) {
            return;
        }

        const ws = this._getOrCreateWorkspace(dirPath);
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
        // Stop heartbeat
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = undefined;
        }
        // Stop countdown timer
        if (this._countdownTimer) {
            clearInterval(this._countdownTimer);
            this._countdownTimer = undefined;
        }
        this._statusBarItem.dispose();
        // Clean up this window's runtime associations
        for (const ws of this._workspaces) {
            const myRuntime = ws.runtimes.find(r => r.windowId === this._windowId);
            if (myRuntime) {
                if (myRuntime.status === 'Local') {
                    // Remove plain Local runtimes entirely (they're just window registrations)
                    ws.runtimes = ws.runtimes.filter(r => r.id !== myRuntime.id);
                } else {
                    // For non-Local runtimes (remote sessions), just detach from this window
                    myRuntime.windowId = undefined;
                }
                this._saveSessions();
                break;
            }
        }
        // Remove empty workspaces
        this._workspaces = this._workspaces.filter(ws => ws.runtimes.length > 0);
        fs.unwatchFile(this._sessionsFilePath);
        this._stopSessionPolling();
        this.disposePersistentShells();
        this.stopAllLogStreams();
        for (const session of this._allRuntimes()) {
            this.cleanupFuseMount(session);
            this.cleanupLocalFuseServer(session);
        }
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
     * Start auto-polling for session status updates. Polls every 5 seconds while
     * there are sessions in non-terminal states that haven't fully set up their tunnel.
     * Automatically stops when all sessions are terminal or have tunnel URLs.
     */
    private _startSessionPolling() {
        if (this._sessionPollTimer) {
            return; // already polling
        }
        this._outputChannel.appendLine('[poll] Starting session auto-poll (every 5s)');

        const doPoll = async () => {
            if (this._sessionPollBusy) { return; }
            this._sessionPollBusy = true;
            try {
                await this.refreshSessions();
            } finally {
                this._sessionPollBusy = false;
            }
            // Stop polling if no sessions need monitoring
            const needsPoll = this._allRuntimes().some(
                s => s.slurmJobId && !s.isLocal
                    && s.status !== 'Failed' && s.status !== 'Completed'
            );
            if (!needsPoll) {
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
        this._metrics.record('ssh_connect', 'in_progress', { target_host: hostName });
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
                this._metrics.record('ssh_connect', 'success', { target_host: hostName }, Date.now() - shellConnectStart);
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
                this._metrics.record('ssh_connect', 'failure', { target_host: hostName }, Date.now() - shellConnectStart, 'SSH connection closed before ready');
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
                this._metrics.record('ssh_connect', 'failure', { target_host: hostName }, Date.now() - shellConnectStart, err.message);
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
                    if (!hostName.includes('*') && !hostName.includes('?')) {
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

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        const isWorkspaces = webviewView.viewType === CybershuttleViewProvider.workspacesViewType;

        if (isWorkspaces) {
            this._workspacesView = webviewView;
        } else {
            this._serversView = webviewView;
        }

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        try {
            if (isWorkspaces) {
                webviewView.webview.html = this._getWorkspacesHtml(webviewView.webview);
            } else {
                webviewView.webview.html = this._getServersHtml(webviewView.webview);
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`[webview] Failed to render: ${err.message}\n${err.stack}`);
            webviewView.webview.html = `<html><body><p>Failed to load CyberShuttle panel: ${err.message}</p></body></html>`;
        }

        // Check Dev Tunnels auth on startup (only once, from the workspaces view)
        if (isWorkspaces) {
            this.checkDevTunnelAuth();
        }

        webviewView.onDidDispose(() => {
            if (isWorkspaces) {
                this._workspacesView = undefined;
                this.disposePersistentShells();
                this.stopAllLogStreams();
            } else {
                this._serversView = undefined;
            }
        });

        // Route messages from both views into the same handler
        webviewView.webview.onDidReceiveMessage((data) => this._onMessage(data));
    }

    /**
     * Central message handler — receives messages from both the Workspaces and Servers webviews.
     */
    private _onMessage(data: any) {
        switch (data.type) {
            case 'auth': {
                vscode.commands.executeCommand('cybershuttle.auth');
                break;
            }
            case 'connectSsh': {
                this.connectToSshHost(data.host);
                break;
            }
            case 'browseDir': {
                this.browseRemoteDir(data.host, data.path);
                break;
            }
            case 'cancelBrowse': {
                // Increment request ID so in-flight results are discarded
                this._browseRequestId.set(data.host, (this._browseRequestId.get(data.host) ?? 0) + 1);
                // Kill the stuck persistent shell so the next browse gets a fresh connection
                const stuckShell = this._persistentShells.get(data.host);
                if (stuckShell) {
                    stuckShell.process.kill();
                    this._persistentShells.delete(data.host);
                }
                this._postWorkspacesMessage({ type: 'browseCancelled', host: data.host });
                break;
            }
            case 'cancelAssociations': {
                const cts = this._associationsCts.get(data.host);
                if (cts) {
                    cts.cancel();
                    this._associationsCts.delete(data.host);
                }
                break;
            }
            case 'refresh': {
                this.refresh();
                break;
            }
            case 'switchToWindow': {
                this.switchToWindow(data.sessionId);
                break;
            }
            case 'expandHost': {
                this._expandedHost = data.host;
                break;
            }
            case 'addSshHost': {
                this.addSshHost();
                break;
            }
            case 'createJob': {
                this.createJob(data.host, data.cpus, data.memory, data.gpu, data.wallTime, data.queue, data.allocation, data.workspaceId);
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
                };
                ws.runtimes.push(newRuntime);
                this._saveSessions();
                this.refreshWorkspaces();
                break;
            }
            case 'queryAssociations': {
                this.queryAssociations(data.host);
                break;
            }
            case 'refreshSessions': {
                this.refreshSessions();
                break;
            }
            case 'relaunchSession': {
                this.relaunchSession(data.sessionId);
                break;
            }
            case 'removeSession': {
                const found = this._findRuntime(data.sessionId);
                if (found) {
                    const rt = found.runtime;
                    // Cancel SLURM job if it has one and is in a non-terminal state
                    if (rt.slurmJobId && rt.status !== 'Failed' && rt.status !== 'Completed') {
                        this.runRemoteCommand(rt.host, `scancel ${rt.slurmJobId}`).catch(() => {});
                    }
                    if (rt.isLocal) { this.stopLocalSession(data.sessionId); }
                    this.cleanupFuseMount(rt);
                    this.cleanupLocalFuseServer(rt);
                    found.workspace.runtimes = found.workspace.runtimes.filter(r => r.id !== data.sessionId);
                    if (found.workspace.runtimes.length === 0) {
                        this._workspaces = this._workspaces.filter(w => w.id !== found.workspace.id);
                    }
                }
                this._saveSessions();
                this.refreshWorkspaces();
                break;
            }
            case 'removeWorkspace': {
                const ws = this._workspaces.find(w => w.id === data.workspaceId);
                if (ws) {
                    // Block deletion if any runtime has an active window
                    if (ws.runtimes.some(r => r.windowId && r.status === 'Local')) {
                        break;
                    }
                    // Cancel all active SLURM jobs in this workspace
                    for (const rt of ws.runtimes) {
                        if (rt.slurmJobId && rt.status !== 'Failed' && rt.status !== 'Completed') {
                            this.runRemoteCommand(rt.host, `scancel ${rt.slurmJobId}`).catch(() => {});
                        }
                        if (rt.isLocal) { this.stopLocalSession(rt.id); }
                        this.cleanupFuseMount(rt);
                        this.cleanupLocalFuseServer(rt);
                    }
                    this._workspaces = this._workspaces.filter(w => w.id !== data.workspaceId);
                }
                this._saveSessions();
                this.refreshWorkspaces();
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
            case 'devTunnelSignIn': {
                this.signInDevTunnel();
                break;
            }
            case 'devTunnelSwitch': {
                this.switchDevTunnelAccount();
                break;
            }
            case 'stopLocal': {
                this.stopLocalSession(data.sessionId);
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
            case 'switchToRemote': {
                this.switchToRemote(data.sessionId);
                break;
            }
            case 'switchToLocal': {
                this.switchToLocal(data.sessionId);
                break;
            }
            case 'openMetrics': {
                vscode.commands.executeCommand('cybershuttle.openMetrics');
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

        let authToken: string;
        try {
            authToken = await this.getDevTunnelAuthToken();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get Dev Tunnels auth token: ${err.message}`);
            return;
        }

        const script = this.generateSlurmScript({ cpus, memory, gpu, wallTime, queue, allocation, authToken });

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

        // Store the session (not yet submitted) and send preview to the Workspaces webview
        this._saveSessions();
        this._postWorkspacesMessage({ type: 'scriptPreview', sessionId: session.id, host: hostName, script });
    }

    /** Patterns that match remote shell initialization noise (module system, MOTD, etc.) */
    private static readonly SHELL_NOISE_PATTERNS = [
        /system default contains no modules/i,
        /LMOD_SYSTEM_DEFAULT_MODULES/,
        /No changes in loaded modules/i,
        /^\s*$/,
    ];

    private static isShellNoise(line: string): boolean {
        return CybershuttleViewProvider.SHELL_NOISE_PATTERNS.some(p => p.test(line));
    }

    private static readonly DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
    private static readonly DEV_TUNNELS_SCOPE = `${CybershuttleViewProvider.DEV_TUNNELS_APP_ID}/.default`;

    /**
     * Ensure the linkspan binary is available locally by downloading the latest
     * release from GitHub if not already cached at ~/.cybershuttle/bin/linkspan.
     */
    private async ensureLocalLinkspan(): Promise<string> {
        const binDir = path.join(os.homedir(), '.cybershuttle', 'bin');
        const binPath = path.join(binDir, 'linkspan');
        if (fs.existsSync(binPath)) {
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
                proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
                proc.on('close', (code) => {
                    if (code === 0) { resolve(); }
                    else { reject(new Error(`Failed to download linkspan: ${stderr}`)); }
                });
                proc.on('error', reject);
            });

            this._outputChannel.appendLine('linkspan downloaded to ' + binPath);
            this._metrics.record('linkspan_deploy', 'success', { deploy_type: 'local' }, Date.now() - deployStart);
            return binPath;
        } catch (err: any) {
            this._metrics.record('linkspan_deploy', 'failure', { deploy_type: 'local' }, Date.now() - deployStart, err.message);
            throw err;
        }
    }

    /**
     * Check Dev Tunnels auth on startup and update the webview auth state.
     */
    private async checkDevTunnelAuth() {
        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [CybershuttleViewProvider.DEV_TUNNELS_SCOPE],
                { silent: true },
            );
            if (session) {
                this._devTunnelAccount = session.account.label;
                this._outputChannel.appendLine('Dev Tunnels: signed in as ' + session.account.label);
            } else {
                this._devTunnelAccount = null;
            }
        } catch {
            this._devTunnelAccount = null;
        }
        this.postAuthState();
    }

    /**
     * Trigger interactive sign-in for Dev Tunnels, then update webview.
     */
    private async signInDevTunnel() {
        try {
            const token = await this.getDevTunnelAuthToken();
            // getSession with createIfNone also gives us the account
            const session = await vscode.authentication.getSession(
                'microsoft',
                [CybershuttleViewProvider.DEV_TUNNELS_SCOPE],
                { silent: true },
            );
            this._devTunnelAccount = session?.account.label ?? 'Signed in';
            this._outputChannel.appendLine('Dev Tunnels: signed in as ' + this._devTunnelAccount);
        } catch (err: any) {
            this._devTunnelAccount = null;
            vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${err.message}`);
        }
        this.postAuthState();
    }

    /**
     * Sign out of the current Microsoft session and prompt to sign in with a different account.
     */
    private async switchDevTunnelAccount() {
        // Clear the current session by requesting it silently, then signing out
        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [CybershuttleViewProvider.DEV_TUNNELS_SCOPE],
                { silent: true },
            );
            if (session) {
                // VS Code doesn't expose a direct "sign out" API for auth providers.
                // The standard way is to use the "clear session preference" approach or
                // ask the user to sign in with { forceNewSession: true }.
                // forceNewSession will prompt user to pick a different account.
            }
        } catch {
            // ignore
        }

        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [CybershuttleViewProvider.DEV_TUNNELS_SCOPE],
                { clearSessionPreference: true, createIfNone: true },
            );
            this._devTunnelAccount = session.account.label;
            this._outputChannel.appendLine('Dev Tunnels: switched to ' + session.account.label);
        } catch (err: any) {
            this._devTunnelAccount = null;
            vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${err.message}`);
        }
        this.postAuthState();
    }

    /**
     * Send current auth state to the Workspaces webview.
     */
    private postAuthState() {
        this._postWorkspacesMessage({ type: 'authState', account: this._devTunnelAccount });
    }

    /**
     * Get a Microsoft Entra ID token for the Dev Tunnels service.
     * Uses VS Code's built-in Microsoft authentication provider,
     * which handles token refresh automatically via refresh tokens.
     */
    private async getDevTunnelAuthToken(): Promise<string> {
        const authStart = Date.now();
        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [CybershuttleViewProvider.DEV_TUNNELS_SCOPE],
                { createIfNone: true },
            );
            this._devTunnelAccount = session.account.label;
            this.postAuthState();
            this._metrics.record('auth_flow', 'success', { stage: 'token_exchange' }, Date.now() - authStart);
            return session.accessToken;
        } catch (err: any) {
            this._metrics.record('auth_flow', 'failure', { stage: 'token_exchange' }, Date.now() - authStart, err.message);
            throw err;
        }
    }

    /**
     * Generate a SLURM batch script from job parameters.
     * The script embeds a workflow YAML and pipes it to linkspan via stdin heredoc.
     * Assumes linkspan is available in PATH.
     */
    private generateSlurmScript(params: {
        cpus: string;
        memory: string;
        gpu: string;
        wallTime: string;
        queue: string;
        allocation: string;
        authToken: string;
        // Optional: local FUSE devtunnel info for mounting Mac's workdir on HPC
        localFuseTunnelId?: string;
        localFuseConnectToken?: string;
        localFusePort?: number;
        sessionId?: string;
    }): string {
        const { cpus, memory, gpu, wallTime, queue, allocation, authToken, localFuseTunnelId, localFuseConnectToken, localFusePort, sessionId } = params;

        // Parse memory value (e.g. "8 GB" → "8G")
        const memSlurm = memory.replace(/\s+/g, '');

        // Build #SBATCH lines.
        // NOTE: SLURM does not expand ~ in --output/--error paths (requires SLURM 23.02+
        // for %h). We redirect stdout/stderr in the script body using $HOME instead.
        const sbatchLines = [
            `#SBATCH --job-name=linkspan-session`,
            `#SBATCH --ntasks=1`,
            `#SBATCH --cpus-per-task=${cpus}`,
            `#SBATCH --mem=${memSlurm}`,
            `#SBATCH --time=${wallTime}`,
            `#SBATCH --partition=${queue}`,
            `#SBATCH --account=${allocation}`,
        ];

        // Add GPU if selected
        if (gpu !== 'None') {
            // Map display name to SLURM gres tag (e.g. "NVIDIA A100" → "gpu:a100:1")
            const gpuTag = gpu.replace('NVIDIA ', '').toLowerCase();
            sbatchLines.push(`#SBATCH --gres=gpu:${gpuTag}:1`);
        }

        // Build the workflow YAML that will be passed to linkspan via stdin.
        // Use $SLURM_JOB_ID in the tunnel name so each job gets a unique tunnel.
        const workflowSteps = [
            `name: "cs-bridge-hpc-setup"`,
            ``,
            `steps:`,
            `  - action: "vscode.create_session"`,
            `    name: "Start SSH server"`,
            `    outputs:`,
            `      bind_port: "ssh_port"`,
            ``,
            `  - action: "fuse.start_server"`,
            `    name: "Start FUSE server"`,
            `    params:`,
            `      root: "$HOME"`,
            `    outputs:`,
            `      fuse_port: "fuse_server_port"`,
            ``,
            `  - action: "tunnel.devtunnel_create"`,
            `    name: "Create devtunnel"`,
            `    params:`,
            `      tunnel_name: "ls-$SLURM_JOB_ID"`,
            `      expiration: "1d"`,
            `      auth_token: "{{.TunnelAuthToken}}"`,
            `      ports:`,
            `        - "{{.ssh_port}}"`,
            `        - "{{.fuse_server_port}}"`,
            `    outputs:`,
            `      tunnel_id: "tunnel_id"`,
            ``,
            `  - action: "tunnel.devtunnel_host"`,
            `    name: "Host devtunnel"`,
            `    params:`,
            `      tunnel_name: "ls-$SLURM_JOB_ID"`,
            `      auth_token: "{{.TunnelAuthToken}}"`,
            `    outputs:`,
            `      connection_url: "tunnel_url"`,
            `      token: "tunnel_token"`,
        ];

        // If local FUSE devtunnel info is provided, add steps to connect and mount
        if (localFuseTunnelId && localFuseConnectToken && localFusePort && sessionId) {
            workflowSteps.push(
                ``,
                `  - action: "tunnel.devtunnel_connect"`,
                `    name: "Connect to local FUSE devtunnel"`,
                `    params:`,
                `      tunnel_id: "${localFuseTunnelId}"`,
                `      access_token: "${localFuseConnectToken}"`,
                ``,
                `  - action: "fuse.mount_remote"`,
                `    name: "Mount local workdir"`,
                `    params:`,
                `      session_id: "${sessionId}"`,
                `      server_addr: "127.0.0.1:${localFusePort}"`,
            );
        }

        const workflowYaml = workflowSteps.join('\n');

        // Use an unquoted heredoc (<<WORKFLOW_EOF) so bash expands $SLURM_JOB_ID
        // in the tunnel name. The Go template variables ({{.…}}) pass through
        // unchanged since they aren't bash syntax.
        //
        // Redirect stdout/stderr to log files using $HOME (since ~ doesn't expand
        // in #SBATCH directives on SLURM < 23.02).
        const script = [
            `#!/bin/bash`,
            ...sbatchLines,
            ``,
            `# --- Set up log files using $HOME ---`,
            `LOG_DIR="$HOME/.cybershuttle/logs"`,
            `mkdir -p "$LOG_DIR"`,
            `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
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
                // If we have a local workspace, start FUSE server for Mac→HPC mount
                if (!this._isRemoteWindow && vscode.workspace.workspaceFolders?.[0]) {
                    try {
                        progress.report({ message: 'Starting local FUSE server...' });
                        const authToken = await this.getDevTunnelAuthToken();
                        await this.startLocalFuseServer(session, authToken);

                        // Regenerate the SLURM script with FUSE mount steps
                        if (session.localFuseTunnelId && session.localFuseConnectToken && session.localFusePort) {
                            session.script = this.generateSlurmScript({
                                cpus: session.cpus,
                                memory: session.memory,
                                gpu: session.gpu,
                                wallTime: session.wallTime,
                                queue: session.queue,
                                allocation: session.allocation,
                                authToken,
                                localFuseTunnelId: session.localFuseTunnelId,
                                localFuseConnectToken: session.localFuseConnectToken,
                                localFusePort: session.localFusePort,
                                sessionId: session.id,
                            });
                            session.connectedRemotePath = `~/sessions/${session.id}`;
                            this._saveSessions();
                        }
                    } catch (err: any) {
                        this._outputChannel.appendLine(`[submit] Warning: Failed to start local FUSE server: ${err.message}`);
                        // Continue without FUSE — the job will still work, just without workdir mount
                    }
                }

                // Deploy linkspan binary to the remote host
                progress.report({ message: 'Deploying linkspan binary...' });
                await this.deployLinkspan(session.host, token);

                progress.report({ message: 'Sending batch script...' });
                const scriptB64 = Buffer.from(session.script!).toString('base64');
                const result = await this.runRemoteCommand(
                    session.host,
                    `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d | sbatch`,
                    token
                );

                if (result.code === 0) {
                    const match = result.stdout.match(/Submitted batch job (\d+)/);
                    session.slurmJobId = match ? match[1] : undefined;
                    session.status = 'Pending';
                    session.errorMessage = undefined;
                    this._outputChannel.appendLine(result.stdout);
                    progress.report({ message: `Job ${session.slurmJobId || ''} submitted — waiting for node allocation...` });
                    this._startSessionPolling();
                    this._metrics.record('job_submit', 'success', { cluster: session.host, cpu: session.cpus, gpu: session.gpu, memory: session.memory, walltime_requested: session.wallTime, job_id_slurm: session.slurmJobId }, Date.now() - submitStart);
                } else {
                    session.status = 'Failed';
                    const errLines = (result.stderr || '').split('\n')
                        .map(l => l.replace(/^sbatch:\s*error:\s*/i, '').trim())
                        .filter(l => l.length > 0);
                    session.errorMessage = errLines.join(' ') || `exit code ${result.code}`;
                    this._outputChannel.appendLine(`sbatch exited with code ${result.code}`);
                    if (result.stderr) {
                        this._outputChannel.appendLine(result.stderr);
                    }
                    vscode.window.showErrorMessage(`Failed to submit job on ${session.host}: ${session.errorMessage}`);
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

            // If submission failed, clean up the local FUSE server (no point keeping it running)
            if (session.status === 'Failed') {
                this.cleanupLocalFuseServer(session);
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
        // Check if linkspan is already deployed
        const check = await this.runRemoteCommand(hostName, 'test -x ~/.cybershuttle/bin/linkspan && echo OK', token);
        if (check.code === 0 && check.stdout.trim() === 'OK') {
            this._outputChannel.appendLine('linkspan already deployed on ' + hostName);
            return;
        }

        this._metrics.record('linkspan_deploy', 'in_progress', { deploy_type: 'remote', target_host: hostName });

        try {
            // Detect remote architecture
            const archResult = await this.runRemoteCommand(hostName, 'uname -m', token);
            if (archResult.code !== 0) {
                throw new Error('Failed to detect remote architecture');
            }
            let arch = archResult.stdout.trim();
            if (arch === 'aarch64') { arch = 'arm64'; }

            // Download latest release from GitHub directly on the remote host
            const assetName = `linkspan_Linux_${arch}.tar.gz`;
            const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;

            await this.runRemoteCommand(
                hostName,
                `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`,
                token
            );

            this._outputChannel.appendLine('linkspan deployed to ' + hostName);
            this._metrics.record('linkspan_deploy', 'success', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart);
        } catch (err: any) {
            this._metrics.record('linkspan_deploy', 'failure', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart, err.message);
            throw err;
        }
    }

    /**
     * Relaunch a failed session by resubmitting its script.
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

            const result = await this.runRemoteCommand(session.host, cmd);

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
     * Spawns a tail -f SSH process that streams stdout/stderr to the webview.
     */
    private toggleSessionLogStream(sessionId: string) {
        // If already tailing, stop it
        if (this._logTailProcesses.has(sessionId)) {
            this.stopSessionLogStream(sessionId);
            return;
        }

        const session = this._findRuntime(sessionId)?.runtime;
        if (!session || !session.slurmJobId) {
            return;
        }

        const jobId = session.slurmJobId;
        const logBase = `$HOME/.cybershuttle/logs/linkspan-session-${jobId}`;
        const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));

        // For failed/completed jobs, just cat the logs. For active/pending, tail -f for real-time streaming.
        // Wrap in bash --norc --noprofile to suppress remote shell init noise (module system, MOTD).
        const isFailed = session.status === 'Failed' || session.status === 'Completed';
        const innerCmd = isFailed
            ? `echo '=== stdout ==='; if [ -f ${logBase}.out ]; then cat ${logBase}.out; else echo '[No log file]'; fi; echo ''; echo '=== stderr ==='; if [ -f ${logBase}.err ]; then cat ${logBase}.err; else echo '[No log file]'; fi`
            : `if [ -f ${logBase}.out ]; then echo '[stdout]'; cat ${logBase}.out; fi; if [ -f ${logBase}.err ]; then echo '[stderr]'; cat ${logBase}.err; fi; tail -n 0 -f ${logBase}.out ${logBase}.err 2>/dev/null`;
        const tailCmd = `bash --norc --noprofile -c '${innerCmd.replace(/'/g, "'\\''")}'`;

        const proc = spawn('ssh', [
            ...this.getControlMasterArgs(session.host),
            '-o', 'NumberOfPasswordPrompts=3',
            session.host,
            tailCmd,
        ], {
            env: {
                ...process.env,
                SSH_ASKPASS: askpassScript,
                SSH_ASKPASS_REQUIRE: 'force',
                CS_ASKPASS_DIR: sessionDir,
                DISPLAY: ':0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this._logTailProcesses.set(sessionId, proc);

        // Tell webview the stream is open
        this._postWorkspacesMessage({ type: 'sessionLogStarted', sessionId });

        proc.stdout!.on('data', (data: Buffer) => {
            this._postWorkspacesMessage({
                type: 'sessionLogData',
                sessionId,
                text: data.toString(),
            });
        });

        proc.stderr!.on('data', (data: Buffer) => {
            // SSH stderr includes remote shell init noise (module system, MOTD) —
            // filter it out so only meaningful content reaches the log panel.
            const text = data.toString();
            const filtered = text.split('\n')
                .filter(l => !CybershuttleViewProvider.isShellNoise(l))
                .join('\n');
            if (filtered.trim() && !text.includes('password') && !text.includes('Permission')) {
                this._postWorkspacesMessage({
                    type: 'sessionLogData',
                    sessionId,
                    text: filtered,
                });
            }
        });

        proc.on('close', () => {
            this._logTailProcesses.delete(sessionId);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this._postWorkspacesMessage({ type: 'sessionLogStopped', sessionId });
        });

        proc.on('error', () => {
            this._logTailProcesses.delete(sessionId);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this._postWorkspacesMessage({ type: 'sessionLogStopped', sessionId });
        });
    }

    private stopSessionLogStream(sessionId: string) {
        const proc = this._logTailProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this._logTailProcesses.delete(sessionId);
        }
        this._postWorkspacesMessage({ type: 'sessionLogStopped', sessionId });
    }

    private stopAllLogStreams() {
        for (const [id, proc] of this._logTailProcesses) {
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
        if (!session || !session.script) {
            vscode.window.showErrorMessage('Session not found or script missing.');
            return;
        }
        // Clear all ephemeral state from the previous run
        session.slurmJobId = undefined;
        session.errorMessage = undefined;
        session.tunnelUrl = undefined;
        session.tunnelToken = undefined;
        session.tunnelId = undefined;
        session.sshPort = undefined;
        await this.submitJob(sessionId);
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
        this._postWorkspacesMessage({ type: 'scriptPreviewDismissed' });
    }

    /**
     * Run linkspan locally for testing the workflow without SSH/SLURM.
     * Spawns linkspan as a child process with the workflow YAML via stdin.
     */
    private async testLocal() {
        const sessionId = crypto.randomBytes(4).toString('hex');

        // Get auth token for Dev Tunnels service before building the workflow
        let authToken: string;
        try {
            authToken = await this.getDevTunnelAuthToken();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to get Dev Tunnels auth token: ${err.message}`);
            return;
        }

        const tunnelName = `ls-${sessionId}`;
        const localWorkdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const workflowYaml = [
            `name: "cs-bridge-hpc-setup"`,
            ``,
            `steps:`,
            `  - action: "vscode.create_session"`,
            `    name: "Start SSH server"`,
            `    outputs:`,
            `      bind_port: "ssh_port"`,
            ``,
            `  - action: "fuse.start_server"`,
            `    name: "Start FUSE server"`,
            `    params:`,
            `      root: "${localWorkdir}"`,
            `    outputs:`,
            `      fuse_port: "fuse_server_port"`,
            ``,
            `  - action: "tunnel.devtunnel_create"`,
            `    name: "Create devtunnel"`,
            `    params:`,
            `      tunnel_name: "${tunnelName}"`,
            `      expiration: "1d"`,
            `      auth_token: "{{.TunnelAuthToken}}"`,
            `      ports:`,
            `        - "{{.ssh_port}}"`,
            `        - "{{.fuse_server_port}}"`,
            `    outputs:`,
            `      tunnel_id: "tunnel_id"`,
            ``,
            `  - action: "tunnel.devtunnel_host"`,
            `    name: "Host devtunnel"`,
            `    params:`,
            `      tunnel_name: "${tunnelName}"`,
            `      auth_token: "{{.TunnelAuthToken}}"`,
            `    outputs:`,
            `      connection_url: "tunnel_url"`,
            `      token: "tunnel_token"`,
        ].join('\n');

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
            await this._launchLinkspanProcess(session, authToken);
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
     * Clears stale runtime state, cleans up the old devtunnel, and re-runs the saved workflow.
     */
    private async _resumeLocalSession(session: Runtime) {
        this._outputChannel.appendLine(`\n--- Resuming local session ${session.id} ---`);

        // Kill stale FUSE mount / SSH tunnel if still alive
        this.cleanupFuseMount(session);

        // Clear stale runtime state but preserve tunnel info (tunnelUrl,
        // tunnelToken, tunnelId) — if the devtunnel is still live the user
        // can reconnect immediately.  The linkspan workflow will overwrite
        // these values once it re-captures them.
        session.localPid = undefined;
        session.sshPort = undefined;
        session.remoteFusePort = undefined;
        session.localMountPath = undefined;
        session.localFuseTunnelUrl = undefined;
        session.remoteMountPath = undefined;
        session.status = 'Submitting';
        this._saveSessions();
        this.refresh();

        let authToken: string;
        try {
            authToken = await this.getDevTunnelAuthToken();
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = `Resume failed: ${err.message}`;
            this._saveSessions();
            this.refresh();
            return;
        }

        try {
            await this._launchLinkspanProcess(session, authToken);
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
                    if (varName === 'ssh_port') {
                        session.sshPort = parseInt(value, 10);
                    } else if (varName === 'tunnel_url') {
                        session.tunnelUrl = value.trim();
                        this._metrics.record('tunnel_create', 'success', { tunnel_type: 'devtunnel', target_host: session.host });
                    } else if (varName === 'tunnel_token') {
                        session.tunnelToken = value.trim();
                    } else if (varName === 'tunnel_id') {
                        session.tunnelId = value.trim();
                    } else if (varName === 'fuse_server_port') {
                        session.remoteFusePort = parseInt(value, 10);
                        // Launch NFS mount for local sessions once we have the FUSE port
                        if (session.isLocal && !session.fuseMountPid) {
                            this.launchFuseMount(session.id);
                        }
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
                    this._metrics.record('tunnel_create', 'failure', { tunnel_type: 'devtunnel', target_host: session.host }, undefined, session.errorMessage);
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
     * Start a background linkspan process serving the local workdir over FUSE
     * with a devtunnel, so a remote session can mount it.
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
     * Remove any CS-Bridge SSH config entry for the given session/host alias.
     */
    private _removeSshConfigEntry(sessionId: string, hostAlias: string): void {
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        try {
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            const re = new RegExp(
                `(?:\\n|^)# CS-Bridge auto-generated for session ${sessionId}\\nHost ${hostAlias}\\n(?:    [^\\n]+\\n)*`,
                'gm'
            );
            const cleaned = content.replace(re, '');
            if (cleaned !== content) {
                fs.writeFileSync(sshConfigPath, cleaned);
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
    ): boolean {
        // Remove any existing entry for this session
        this._removeSshConfigEntry(sessionId, hostAlias);

        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        const configBlock = [
            ``,
            `# CS-Bridge auto-generated for session ${sessionId}`,
            `Host ${hostAlias}`,
            `    HostName ${hostname}`,
            `    Port ${port}`,
            `    User ${user}`,
            `    StrictHostKeyChecking no`,
            `    UserKnownHostsFile /dev/null`,
        ].join('\n');

        try {
            fs.appendFileSync(sshConfigPath, configBlock + '\n');
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update SSH config: ${err.message}`);
            return false;
        }

        return true;
    }

    /**
     * Mount a remote FUSE filesystem locally via NFS using the linkspan binary.
     *
     * For local sessions: connects directly to 127.0.0.1:<fusePort>.
     * For remote SLURM sessions: sets up SSH port forwarding through the login
     * node to the compute node's FUSE port, then mounts via NFS.
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
            title: `Cancelling job ${session.slurmJobId} on ${session.host}`,
            cancellable: false,
        }, async (progress) => {
            this._outputChannel.appendLine(`\n--- Cancelling SLURM job ${session.slurmJobId} on ${session.host} ---`);
            progress.report({ message: 'Sending scancel...' });

            try {
                const result = await this.runRemoteCommand(
                    session.host,
                    `scancel ${session.slurmJobId}`
                );
                if (result.code === 0) {
                    session.status = 'Completed';
                    session.errorMessage = undefined;
                    this._outputChannel.appendLine(`Job ${session.slurmJobId} cancelled.`);
                    progress.report({ message: 'Job cancelled.' });
                } else {
                    this._outputChannel.appendLine(`scancel failed: ${result.stderr}`);
                }
            } catch (err: any) {
                this._outputChannel.appendLine(`Error cancelling job: ${err.message}`);
            }

            // Clean up local FUSE mount if active
            this.cleanupFuseMount(session);
            this.cleanupLocalFuseServer(session);

            // Remove auto-generated SSH config entry for remote session
            this._removeSshConfigEntry(sessionId, `cs-session-${sessionId}`);

            // Clear ephemeral tunnel/connection properties
            session.tunnelUrl = undefined;
            session.tunnelToken = undefined;
            session.tunnelId = undefined;
            session.sshPort = undefined;
            session.remoteFusePort = undefined;
            session.computeNode = undefined;

            this.stopSessionLogStream(sessionId);
            this._saveSessions();
            this.refresh();
        });
    }

    private stopLocalSession(sessionId: string) {
        // Kill FUSE mount helper and SSH tunnel if running
        const fuseSession = this._findRuntime(sessionId)?.runtime;
        if (fuseSession) {
            this.cleanupFuseMount(fuseSession);
            this.cleanupLocalFuseServer(fuseSession);
        }

        // Kill linkspan process — try local map first, fall back to PID for cross-window stop
        const proc = this._localProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this._localProcesses.delete(sessionId);
        } else {
            const session = this._findRuntime(sessionId)?.runtime;
            if (session?.localPid) {
                try { process.kill(session.localPid, 'SIGTERM'); } catch { /* already dead */ }
            }
        }

        // Clean up the devtunnel (safety net — linkspan shutdown should do this too)
        const tunnelName = `ls-${sessionId}`;
        const dtBin2 = this._resolveDevTunnelBin();
        if (dtBin2) { spawn(dtBin2, ['delete', tunnelName, '-f'], { stdio: 'ignore', detached: true }).unref(); }

        // Remove auto-generated SSH config entry
        this._removeSshConfigEntry(sessionId, `cs-tunnel-${sessionId}`);

        const session = this._findRuntime(sessionId)?.runtime;
        if (session) {
            session.status = 'Completed';
            session.localPid = undefined;
            session.tunnelUrl = undefined;
            session.tunnelToken = undefined;
            session.tunnelId = undefined;
            session.sshPort = undefined;
            session.localWorkdir = undefined;
            session.localFuseTunnelUrl = undefined;
            session.remoteFusePort = undefined;
            session.remoteMountPath = undefined;
            session.localFuseServerPid = undefined;
            session.localFuseTunnelId = undefined;
            session.localFuseConnectToken = undefined;
            session.localFusePort = undefined;
            this._saveSessions();
            this.refresh();
        }
    }

    /**
     * Refresh session statuses by querying squeue on the remote host.
     * RUNNING → Active, PENDING → Pending, no output → completed/removed.
     */
    private async refreshSessions() {
        // Only check sessions that are still in a non-terminal state
        const sessionsToCheck = this._allRuntimes().filter(
            s => s.slurmJobId && s.status !== 'Failed' && s.status !== 'Completed'
        );
        if (sessionsToCheck.length === 0) {
            this._sendRuntimeUpdates();
            this._updateStatusBar();
            return;
        }

        for (const session of sessionsToCheck) {
            try {
                const oldStatus = session.status;
                const squeueStart = Date.now();
                const result = await this.runRemoteCommand(
                    session.host,
                    `squeue -j ${session.slurmJobId} -h -o "%T %N"`
                );
                this._metrics.record('sinfo_fetch', 'success', { cluster: session.host, raw_output_truncated: result.stdout.slice(0, 200) }, Date.now() - squeueStart);

                const parts0 = result.stdout.trim().split(/\s+/);
                const state = parts0[0] || '';
                const nodeName = parts0[1] || '';
                if (result.code === 0 && state) {
                    if (state === 'RUNNING') {
                        session.status = 'Active';
                        session.errorMessage = undefined;
                        if (nodeName && !session.computeNode) {
                            session.computeNode = nodeName;
                        }
                    } else if (state === 'PENDING' || state === 'CONFIGURING') {
                        session.status = 'Pending';
                        session.errorMessage = undefined;
                    } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT' || state === 'NODE_FAIL' || state === 'OUT_OF_MEMORY') {
                        session.status = 'Failed';
                        session.errorMessage = `Job ${state}`;
                    }
                } else {
                    // Job no longer in squeue — use sacct to determine final state
                    try {
                        const sacctResult = await this.runRemoteCommand(
                            session.host,
                            `sacct -j ${session.slurmJobId} -n -o State%20,ExitCode,Reason%40 --parsable2 2>/dev/null | head -1`
                        );
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

                // Clear ephemeral tunnel/connection properties for terminal sessions
                if (session.status === 'Failed' || session.status === 'Completed') {
                    this.cleanupFuseMount(session);
                    session.tunnelUrl = undefined;
                    session.tunnelToken = undefined;
                    session.tunnelId = undefined;
                    session.sshPort = undefined;
                    session.remoteFusePort = undefined;
                    session.computeNode = undefined;
                }

                // Record status transitions
                if (session.status !== oldStatus) {
                    this._metrics.record('job_status_change', session.status === 'Failed' ? 'failure' : 'success', {
                        job_id_slurm: session.slurmJobId!,
                        old_status: oldStatus,
                        new_status: session.status,
                        cluster: session.host,
                    });
                }

                // Always parse linkspan logs to capture workflow variables
                // (tunnel_url, tunnel_token, ssh_port) regardless of job state.
                await this.parseSlurmSessionLogs(session);
            } catch {
                // SSH error — leave session in its current state
            }
        }

        this._saveSessions();
        this._sendRuntimeUpdates();
        this._updateStatusBar();

        // Auto-switch if runtime just became active and has switchOnReady
        for (const session of this._allRuntimes()) {
            if (session.switchOnReady && session.status === 'Active' && session.tunnelUrl) {
                session.switchOnReady = false;
                this._saveSessions();
                await this.switchToRemote(session.id);
                break; // Only switch to one at a time
            }
        }
    }

    /**
     * Fetch the linkspan stderr log for a SLURM session and parse workflow
     * variable captures (ssh_port, tunnel_url, tunnel_token, tunnel_id,
     * fuse_server_port) and workflow step errors.
     * Called during refreshSessions when a job is RUNNING.
     */
    private async parseSlurmSessionLogs(session: Runtime) {
        if (!session.slurmJobId) { return; }
        // Skip if we already captured all workflow variables
        if (session.tunnelUrl && session.tunnelToken && session.sshPort && session.remoteFusePort) { return; }

        // Use $HOME instead of ~ for reliable expansion in all shell contexts.
        const logFile = `$HOME/.cybershuttle/logs/linkspan-session-${session.slurmJobId}.err`;
        try {
            const result = await this.runRemoteCommand(
                session.host,
                `if [ -f ${logFile} ]; then tail -c 65536 ${logFile}; fi`
            );
            if (result.code !== 0 || !result.stdout) { return; }

            for (const line of result.stdout.split('\n')) {
                const cap = line.match(/workflow: captured (\S+) = (.+)/);
                if (cap) {
                    const [, varName, value] = cap;
                    if (varName === 'ssh_port') {
                        session.sshPort = parseInt(value, 10);
                    } else if (varName === 'tunnel_url') {
                        session.tunnelUrl = value.trim();
                    } else if (varName === 'tunnel_token') {
                        session.tunnelToken = value.trim();
                    } else if (varName === 'tunnel_id') {
                        session.tunnelId = value.trim();
                    } else if (varName === 'fuse_server_port') {
                        session.remoteFusePort = parseInt(value, 10);
                    }
                    continue;
                }

                const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): (.+)/);
                if (errMatch) {
                    session.status = 'Failed';
                    session.errorMessage = `${errMatch[1]}: ${errMatch[2].trim()}`;
                }
            }

            // Trigger local NFS mount when we have the remote FUSE port and compute node
            if (session.remoteFusePort && session.computeNode && !session.fuseMountPid) {
                this.launchFuseMount(session.id);
            }
        } catch {
            // SSH error — skip log parsing this cycle
        }
    }

    /**
     * Query SLURM partition and account info for the current user on a remote host
     * using scripts/info.sh. Sends a partition→info mapping to the webview
     * to populate the Partition and Allocation dropdowns.
     */
    private async queryAssociations(hostName: string) {
        // Cancel any in-flight fetch for this host
        const prev = this._associationsCts.get(hostName);
        if (prev) { prev.cancel(); }

        const cts = new vscode.CancellationTokenSource();
        this._associationsCts.set(hostName, cts);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
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
                const result = await this.runRemoteCommand(
                    hostName,
                    '',
                    token,
                    infoScript + '\nexit 0\n'
                );

                this._outputChannel.appendLine(`info.sh exit code: ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(`info.sh stderr: ${result.stderr}`);
                }

                if (result.code === 0) {
                    this._outputChannel.appendLine(`info.sh stdout: [${result.stdout}]`);

                    const lines = result.stdout.trim().split('\n');
                    const partitions: { [name: string]: { accounts: string[]; nodes: number; maxCpus: number; maxGpus: number } } = {};

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (!line || line.startsWith('partition|')) { continue; }
                        const parts = line.split('|');
                        if (parts.length >= 5) {
                            const name = parts[0].trim();
                            const nodes = parseInt(parts[1].trim(), 10) || 0;
                            const maxCpus = parseInt(parts[2].trim(), 10) || 0;
                            const maxGpus = parseInt(parts[3].trim(), 10) || 0;
                            const accounts = parts[4].trim().split(',').filter(a => a.length > 0);
                            if (name) {
                                partitions[name] = { accounts, nodes, maxCpus, maxGpus };
                            }
                        }
                    }

                    // Fallback: if info.sh produced no partition rows, get basic list from sinfo
                    if (Object.keys(partitions).length === 0) {
                        this._outputChannel.appendLine('No partitions from info.sh, falling back to sinfo');
                        const fallback = await this.runRemoteCommand(
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
                                        maxGpus: 0,
                                    };
                                }
                            }
                        }
                        this._outputChannel.appendLine(`Fallback parsed ${Object.keys(partitions).length} partitions`);
                    }

                    progress.report({ message: 'Done.' });
                    this._cachedAssociations.set(hostName, partitions);
                    this.postMessage({ type: 'associations', host: hostName, partitions });
                } else {
                    this._outputChannel.appendLine(`Command exited with code ${result.code}`);
                    if (result.stderr) {
                        this._outputChannel.appendLine(result.stderr);
                    }
                    this.postMessage({ type: 'associationsError', host: hostName, error: result.stderr || `exit code ${result.code}` });
                }
                this._outputChannel.appendLine(`--- End of partition info ---\n`);
            } catch (err: any) {
                if (err.cancelled) {
                    this._outputChannel.appendLine('Partition query cancelled by user');
                    this.postMessage({ type: 'associationsCancelled', host: hostName });
                } else {
                    this._outputChannel.appendLine(`Error: ${err.message}`);
                    this.postMessage({ type: 'associationsError', host: hostName, error: err.message });
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
            // Try to get the remote home directory, fall back to /
            const homeResult = await this.runRemoteCommand(hostName, 'echo $HOME').catch(() => null);
            const defaultPath = homeResult?.code === 0 && homeResult.stdout.trim() ? homeResult.stdout.trim() : '/';

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

        // If runtime is idle (not yet launched), launch it first then auto-switch when ready
        if (!session.slurmJobId && session.status === 'Idle') {
            session.switchOnReady = true;
            session.status = 'Submitting';
            this._saveSessions();
            this._sendRuntimeUpdates();
            try {
                const authToken = await this.getDevTunnelAuthToken();
                const script = this.generateSlurmScript({
                    cpus: session.cpus,
                    memory: session.memory,
                    gpu: session.gpu,
                    wallTime: session.wallTime,
                    queue: session.queue,
                    allocation: session.allocation,
                    authToken,
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

        // If runtime previously ran and is now terminated, re-launch it
        if (session.slurmJobId && (session.status === 'Failed' || session.status === 'Completed')) {
            // Clear old job state
            session.slurmJobId = undefined;
            session.tunnelUrl = undefined;
            session.tunnelToken = undefined;
            session.tunnelId = undefined;
            session.sshPort = undefined;
            session.remoteFusePort = undefined;
            session.computeNode = undefined;
            session.errorMessage = undefined;
            session.script = undefined;
            // Now treat it like an Idle runtime
            session.switchOnReady = true;
            session.status = 'Submitting';
            this._saveSessions();
            this._sendRuntimeUpdates();
            try {
                const authToken = await this.getDevTunnelAuthToken();
                const script = this.generateSlurmScript({
                    cpus: session.cpus, memory: session.memory, gpu: session.gpu,
                    wallTime: session.wallTime, queue: session.queue, allocation: session.allocation,
                    authToken,
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

            // Resolve remote workspace path
            let remotePath = session.connectedRemotePath;

            // Resolve ~ to absolute path via SSH to login node
            if (remotePath && remotePath.startsWith('~')) {
                progress.report({ message: 'Resolving remote home directory...' });
                try {
                    const result = await this.runRemoteCommand(session.host, 'echo $HOME');
                    const remoteHome = result.stdout.trim();
                    if (remoteHome) {
                        remotePath = remotePath.replace(/^~/, remoteHome);
                        session.connectedRemotePath = remotePath;
                    }
                } catch {
                    // Fall through — will try with unresolved path
                }
            }

            if (!remotePath) {
                if (session.isLocal && session.localWorkdir) {
                    remotePath = `${os.homedir()}/sessions/${sessionId}`;
                } else {
                    progress.report({ message: 'Resolving remote home directory...' });
                    try {
                        const result = await this.runRemoteCommand(session.host, 'echo $HOME');
                        remotePath = result.stdout.trim() || '/home';
                    } catch {
                        remotePath = '/home';
                    }
                }
                session.connectedRemotePath = remotePath;
            }
            this._saveSessions();

            progress.report({ message: 'Opening remote folder...' });

            if (session.isLocal) {
                // Local sessions: connect via devtunnel SSH on localhost
                const hostAlias = `cs-tunnel-${sessionId}`;
                if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshPort!, 'user')) {
                    return;
                }

                this._outputChannel.appendLine(
                    `[switch] Opening remote folder: scheme=vscode-remote, authority=ssh-remote+${hostAlias}, path=${remotePath}`
                );
                vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${hostAlias}`,
                        path: remotePath,
                    }),
                    { forceNewWindow: false }
                );
            } else if (session.sshPort && session.tunnelId && session.tunnelToken) {
                // Remote sessions: forward SSH port via Dev Tunnel (bypasses compute node firewall)
                const hostAlias = `cs-session-${sessionId}`;

                // Ensure shared devtunnel connect is running
                if (!session.sshTunnelLocalPort) {
                    progress.report({ message: 'Connecting to Dev Tunnel...' });
                    const portMap = await this._ensureDevTunnelConnected(sessionId, session);
                    if (!portMap) {
                        vscode.window.showErrorMessage('Failed to connect to Dev Tunnel. Check the Cybershuttle output channel for details.');
                        return;
                    }

                    const localSshPort = portMap.get(session.sshPort);
                    if (!localSshPort) {
                        vscode.window.showErrorMessage(`Dev Tunnel connected but SSH port ${session.sshPort} was not forwarded.`);
                        return;
                    }

                    session.sshTunnelLocalPort = localSshPort;
                    this._saveSessions();
                }

                // Create/update SSH config entry pointing to the Dev Tunnel local port
                if (!this._writeSshConfigEntry(sessionId, hostAlias, '127.0.0.1', session.sshTunnelLocalPort!, 'user')) {
                    return;
                }

                this._outputChannel.appendLine(
                    `[switch] Opening remote folder: scheme=vscode-remote, authority=ssh-remote+${hostAlias}, path=${remotePath}`
                );
                vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${hostAlias}`,
                        path: remotePath,
                    }),
                    { forceNewWindow: false }
                );
            } else {
                // Remote sessions without compute node: connect to login node
                this._outputChannel.appendLine(
                    `[switch] Opening remote folder: scheme=vscode-remote, authority=ssh-remote+${session.host}, path=${remotePath}`
                );
                vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.from({
                        scheme: 'vscode-remote',
                        authority: `ssh-remote+${session.host}`,
                        path: remotePath,
                    }),
                    { forceNewWindow: false }
                );
            }
        });
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

        const localPath = session.localMountPath || session.localWorkspaceFolder || os.homedir();

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
                    this._metrics.record('ssh_connect', 'failure', { target_host: hostName }, duration, 'Cancelled');
                    reject(err);
                } else {
                    this._metrics.record('ssh_connect', (code ?? 1) === 0 ? 'success' : 'failure', { target_host: hostName }, duration, code !== 0 ? `exit code ${code}` : undefined);
                    resolve({ stdout: stdoutData, stderr: stderrData, code: code ?? 1 });
                }
            });

            sshProcess.on('error', (err: Error) => {
                cleanup();
                this._metrics.record('ssh_connect', 'failure', { target_host: hostName }, Date.now() - cmdStart, err.message);
                reject(err);
            });
        });
    }

    /**
     * Browse a directory on a remote SSH host.
     * Parses ls output into structured entries and sends to the webview.
     */
    private async browseRemoteDir(hostName: string, remotePath: string) {
        const reqId = (this._browseRequestId.get(hostName) ?? 0) + 1;
        this._browseRequestId.set(hostName, reqId);

        this._postWorkspacesMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: true, entries: [] });

        try {
            // Use persistent shell for fast sequential browsing
            const result = await this._runShellCommand(
                hostName,
                `cd ${remotePath} && pwd && ls -lAhp`
            );

            // Discard if a newer request (or cancel) has superseded this one
            if (this._browseRequestId.get(hostName) !== reqId) { return; }

            if (result.code === 0) {
                const lines = result.stdout.split('\n');
                const resolvedPath = lines[0].trim();
                const entries: { name: string; isDir: boolean; size: string }[] = [];

                // Skip the "total ..." line (line index 1), parse the rest
                for (let i = 2; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) { continue; }
                    // ls -lAhp format: perms links owner group size month day time name
                    const parts = line.split(/\s+/);
                    if (parts.length < 9) { continue; }
                    const size = parts[4];
                    const name = parts.slice(8).join(' ');
                    if (name === './' || name === '../') { continue; }
                    const isDir = name.endsWith('/');
                    entries.push({ name: isDir ? name.slice(0, -1) : name, isDir, size });
                }

                // Sort: directories first, then alphabetical
                entries.sort((a, b) => {
                    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
                    return a.name.localeCompare(b.name);
                });

                this._postWorkspacesMessage({ type: 'fileListing', host: hostName, path: resolvedPath, loading: false, entries });
            } else {
                this._postWorkspacesMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: false, entries: [], error: `exit code ${result.code}` });
            }
        } catch (err: any) {
            if (this._browseRequestId.get(hostName) !== reqId) { return; }
            this._postWorkspacesMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: false, entries: [], error: err.message });
        }
    }

    /**
     * Refresh the Workspaces webview content.
     */
    public refreshWorkspaces() {
        if (this._workspacesView) {
            try {
                this._workspacesView.webview.html = this._getWorkspacesHtml(this._workspacesView.webview);
            } catch (err: any) {
                this._outputChannel.appendLine(`[webview] Failed to render workspaces: ${err.message}`);
            }
        }
    }

    /**
     * Send incremental runtime status updates to the workspaces webview
     * without replacing the entire HTML. Preserves host picker state,
     * form values, and scroll position.
     */
    private _sendRuntimeUpdates() {
        const activeSession = this._detectActiveSession();
        const updates = this._workspaces.map(ws => ({
            workspaceId: ws.id,
            runtimes: ws.runtimes.map(rt => ({
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
                slurmJobId: rt.slurmJobId,
                errorMessage: rt.errorMessage,
                submittedAt: rt.submittedAt,
            })),
        }));
        this._postWorkspacesMessage({ type: 'updateRuntimes', updates });
    }

    /**
     * Refresh the Servers webview content.
     */
    public refreshServers() {
        if (this._serversView) {
            try {
                this._serversView.webview.html = this._getServersHtml(this._serversView.webview);
                // Re-send cached associations so expanded host keeps its partition data
                if (this._expandedHost) {
                    const cached = this._cachedAssociations.get(this._expandedHost);
                    if (cached) {
                        this._postServersMessage({ type: 'associations', host: this._expandedHost, partitions: cached });
                        // Also send to workspaces for host picker forms
                        this._postWorkspacesMessage({ type: 'associations', host: this._expandedHost, partitions: cached });
                    }
                }
            } catch (err: any) {
                this._outputChannel.appendLine(`[webview] Failed to render servers: ${err.message}`);
            }
        }
    }

    /**
     * Refresh both webviews.
     */
    public refresh() {
        this._pruneStaleWindows();
        this.refreshWorkspaces();
        this.refreshServers();
        this._updateStatusBar();
    }

    /**
     * Send a message to the Workspaces webview.
     */
    public _postWorkspacesMessage(message: unknown) {
        if (this._workspacesView) {
            this._workspacesView.webview.postMessage(message);
        }
    }

    /**
     * Send a message to the Servers webview.
     */
    public _postServersMessage(message: unknown) {
        if (this._serversView) {
            this._serversView.webview.postMessage(message);
        }
    }

    /**
     * Legacy helper: send a message to both webviews (used for shared state like associations).
     */
    public postMessage(message: unknown) {
        this._postWorkspacesMessage(message);
        this._postServersMessage(message);
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
        .codicon {
            font: normal normal normal 16px/1 codicon;
            display: inline-block;
            text-decoration: none;
            text-rendering: auto;
            text-align: center;
            user-select: none;
        }
        body {
            padding: 10px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        h2 {
            margin-top: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        button {
            padding: 8px 12px;
            margin: 8px 0;
            border: none;
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 13px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .full-width {
            display: block;
            width: 100%;
        }
        .description {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-bottom: 16px;
        }
        .ssh-host {
            display: flex;
            flex-direction: column;
            padding: 4px 8px;
            margin: 1px 0;
            background: var(--vscode-list-hoverBackground);
            border-radius: 3px;
        }
        .ssh-host-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
        }
        .host-info {
            display: flex;
            align-items: baseline;
            gap: 6px;
            overflow: hidden;
            min-width: 0;
        }
        .host-name {
            font-weight: 600;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex-shrink: 0;
        }
        .host-detail {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chevron {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.15s ease;
            flex-shrink: 0;
            transform: rotate(90deg);
        }
        .ssh-host-row.expanded .chevron {
            transform: rotate(270deg);
        }
        .job-form {
            width: 100%;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .form-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
        }
        .form-row label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
            width: 70px;
        }
        .form-select {
            flex: 1;
            padding: 4px 6px;
            font-size: 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            outline: none;
        }
        .form-select:focus {
            border-color: var(--vscode-focusBorder);
        }
        .submit-job-btn {
            width: 100%;
            margin: 6px 0 0 0;
            padding: 6px 10px;
            font-size: 12px;
        }
        .job-form-loading {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 0;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .job-form-error {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 0;
            font-size: 12px;
            color: var(--vscode-errorForeground);
        }
        .job-form-retry-btn {
            margin: 0;
            padding: 2px 8px;
            font-size: 11px;
            flex-shrink: 0;
        }
        .job-form-stop-btn {
            padding: 2px 6px;
            font-size: 10px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-errorForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            margin-left: auto;
        }
        .job-form-stop-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .skeleton {
            display: inline-block;
            background: linear-gradient(90deg,
                var(--vscode-editor-inactiveSelectionBackground) 25%,
                var(--vscode-list-hoverBackground) 50%,
                var(--vscode-editor-inactiveSelectionBackground) 75%
            );
            background-size: 200% 100%;
            animation: shimmer 1.5s ease-in-out infinite;
            border-radius: 3px;
        }
        .skeleton-text {
            height: 12px;
            vertical-align: middle;
        }
        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
        .job-form-fields {
            display: none;
        }
        .empty-message {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 16px 0;
        }
        .refresh-btn {
            padding: 2px 8px;
            font-size: 11px;
            margin: 0;
        }
        .section {
            margin-bottom: 20px;
        }
        `;
    }

    /**
     * Generate the HTML for the WORKSPACES webview.
     * Contains: auth bar, description, workspace cards (sessions + file browser), script preview overlay.
     */
    private _getWorkspacesHtml(webview: vscode.Webview): string {
        // Use a nonce to only allow a specific script to run
        const nonce = getNonce();

        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.ttf'));

        // Get SSH hosts from config — used for the workspace host picker
        const sshHosts = this.getSshHosts();

        // Build sessions HTML — workspace-grouped cards
        const activeSession = this._detectActiveSession();

        // Helper: build runtime row HTML for one Runtime
        const buildRuntimeRow = (rt: Runtime): string => {
            const isActiveInThisWindow = activeSession?.id === rt.id;
            const isLocal = !!rt.isLocal;

            // Determine status icon
            // Blue = has an active VS Code window connected (any window, not just this one)
            let statusIconHtml: string;
            if (rt.status === 'Local' && rt.windowId) {
                // Local runtime with an active window
                statusIconHtml = `<span class="status-icon">🔵</span>`;
            } else if (isActiveInThisWindow) {
                // This window's remote runtime
                statusIconHtml = `<span class="status-icon">🔵</span>`;
            } else if (rt.status === 'Active' && rt.windowId) {
                // Remote runtime with an active window connected (from another window)
                statusIconHtml = `<span class="status-icon">🔵</span>`;
            } else if (rt.status === 'Active') {
                // Active but no window connected yet
                statusIconHtml = `<span class="status-icon">🟢</span>`;
            } else if (rt.status === 'Submitting') {
                // SLURM job being submitted
                statusIconHtml = `<span class="status-icon status-flash">🟡</span>`;
            } else if (rt.status === 'Pending') {
                // Job queued, waiting for resources
                statusIconHtml = `<span class="status-icon">🟡</span>`;
            } else {
                // Idle, Completed, Failed, or any saved state
                statusIconHtml = `<span class="status-icon">⚪</span>`;
            }

            // Determine this-window indicator
            const isThisWindowRuntime = (rt.status === 'Local' && rt.windowId === this._windowId) || isActiveInThisWindow;

            // Determine action buttons
            let headerRightHtml: string;
            if (isThisWindowRuntime) {
                headerRightHtml = `<span class="session-badge">this window</span>`;
            } else {
                const switchDirection = rt.status === 'Local' ? 'local-window' : 'remote';
                const switchBtn = `<button class="session-action-btn switch-btn" data-session-id="${escapeHtml(rt.id)}" data-direction="${switchDirection}" title="Switch">&#x21C4;</button>`;
                const removeBtn = `<button class="remove-session-btn" data-session-id="${escapeHtml(rt.id)}" title="Remove">✕</button>`;
                headerRightHtml = `${switchBtn}${removeBtn}`;
            }

            // Determine display name
            const displayName = rt.status === 'Local' ? 'Local' : escapeHtml(rt.host);

            // Build detail section for non-local runtimes
            let detailHtml = '';
            if (rt.status !== 'Local') {
                const wtParts = rt.wallTime.split(':').map(Number);
                const wtTotalMin = (wtParts[0] || 0) * 60 + (wtParts[1] || 0);
                const wallTimeShort = wtTotalMin >= 1440 ? `${Math.floor(wtTotalMin / 1440)}d` : wtTotalMin >= 60 ? `${Math.floor(wtTotalMin / 60)}hr` : `${wtTotalMin}min`;
                // Line 1: resource specs inline
                const gpuPart = rt.gpu !== 'None' ? ` ${escapeHtml(rt.gpu)}` : '';
                const line1 = `${escapeHtml(rt.cpus)} ${escapeHtml(rt.memory)}${gpuPart} ${wallTimeShort}`;
                // Line 2: status + tunnel
                let line2 = '';
                if (rt.status === 'Active') {
                    const deadlineMs = new Date(rt.submittedAt).getTime() + wtTotalMin * 60000;
                    const countdownSpan = `<span class="session-countdown" data-deadline="${deadlineMs}"></span>`;
                    if (rt.tunnelUrl) {
                        line2 = `${countdownSpan} ${escapeHtml(rt.tunnelUrl)}`;
                    } else {
                        line2 = `${countdownSpan} setting up tunnel...`;
                    }
                } else if (rt.status === 'Submitting') {
                    line2 = 'submitting job...';
                } else if (rt.status === 'Pending') {
                    line2 = 'queued, waiting for resources...';
                } else if (rt.status === 'Failed') {
                    line2 = rt.errorMessage ? `failed: ${escapeHtml(rt.errorMessage)}` : 'failed';
                } else if (rt.status === 'Completed') {
                    line2 = 'completed';
                }
                detailHtml = `
                    <div class="runtime-details">
                        <span class="session-detail">${escapeHtml(rt.queue)} ${escapeHtml(rt.allocation)} ${line1}</span>
                        <span class="session-detail session-status-line">${line2}</span>
                    </div>`;
            }

            return `
                <div class="runtime-entry" data-session-id="${escapeHtml(rt.id)}">
                    <div class="runtime-header">
                        <span class="runtime-name">${statusIconHtml} ${displayName}</span>
                        <div class="runtime-header-right">
                            ${headerRightHtml}
                        </div>
                    </div>${detailHtml}
                </div>`;
        };

        // Helper: build the host picker HTML for a workspace
        const buildHostPickerHtml = (ws: Workspace): string => {
            if (sshHosts.length === 0) {
                return '<p class="empty-message" style="margin:8px;">No SSH hosts found in ~/.ssh/config</p>';
            }
            return sshHosts.map(host => `
                <div class="host-picker-item">
                    <div class="host-picker-row" data-host="${escapeHtml(host.name)}" data-workspace-id="${escapeHtml(ws.id)}">
                        <span class="host-picker-chevron">&#x203A;</span>
                        <span class="host-picker-name">${escapeHtml(host.name)}</span>
                        ${host.hostname ? `<span class="host-picker-detail">${host.user ? escapeHtml(host.user) + '@' : ''}${escapeHtml(host.hostname)}</span>` : ''}
                    </div>
                    <div class="host-picker-form" id="host-form-${escapeHtml(ws.id)}-${escapeHtml(host.name)}" style="display:none;">
                        <div class="job-form-loading" style="display:none;"><div class="spinner"></div>Fetching partitions...</div>
                        <div class="job-form-error" style="display:none;"><span class="job-form-error-text"></span></div>
                        <div class="job-form-fields" style="display:none;">
                            <div class="form-row"><label>CPUs</label><select class="form-select" data-field="cpus">
                                <option value="1">1</option><option value="2">2</option><option value="4">4</option>
                                <option value="8">8</option><option value="16">16</option><option value="32">32</option><option value="64">64</option>
                            </select></div>
                            <div class="form-row"><label>Memory</label><select class="form-select" data-field="memory">
                                <option value="1 GB">1 GB</option><option value="2 GB">2 GB</option><option value="4 GB">4 GB</option>
                                <option value="8 GB">8 GB</option><option value="16 GB">16 GB</option><option value="32 GB">32 GB</option>
                                <option value="64 GB">64 GB</option><option value="128 GB">128 GB</option>
                            </select></div>
                            <div class="form-row"><label>GPU</label><select class="form-select" data-field="gpu">
                                <option value="None">None</option><option value="NVIDIA A100">NVIDIA A100</option>
                                <option value="NVIDIA V100">NVIDIA V100</option><option value="NVIDIA T4">NVIDIA T4</option>
                                <option value="NVIDIA A40">NVIDIA A40</option><option value="NVIDIA H100">NVIDIA H100</option>
                            </select></div>
                            <div class="form-row"><label>Wall Time</label><select class="form-select" data-field="wallTime">
                                <option value="00:30:00">30 min</option><option value="01:00:00">1 hour</option>
                                <option value="02:00:00">2 hours</option><option value="04:00:00">4 hours</option>
                                <option value="08:00:00">8 hours</option><option value="12:00:00">12 hours</option>
                                <option value="24:00:00">24 hours</option>
                            </select></div>
                            <div class="form-row"><label>Allocation</label><select class="form-select" data-field="allocation" data-host="${escapeHtml(host.name)}">
                                <option value="">Loading...</option>
                            </select></div>
                            <div class="form-row"><label>Partition</label><select class="form-select" data-field="queue" data-host="${escapeHtml(host.name)}">
                                <option value="">Select allocation first</option>
                            </select></div>
                            <button class="submit-job-btn" data-host="${escapeHtml(host.name)}" data-workspace-id="${escapeHtml(ws.id)}">Add</button>
                        </div>
                    </div>
                </div>
            `).join('');
        };

        // Build workspace cards
        const sessionsHtml = this._workspaces.length > 0
            ? this._workspaces.map(ws => {
                const sortedRuntimes = [...ws.runtimes].sort((a, b) => {
                    if (a.windowId === this._windowId) { return -1; }
                    if (b.windowId === this._windowId) { return 1; }
                    const statusOrder: Record<string, number> = { Local: 0, Active: 1, Submitting: 2, Pending: 3, Idle: 4, Failed: 5, Completed: 6 };
                    const sa = statusOrder[a.status] ?? 99;
                    const sb = statusOrder[b.status] ?? 99;
                    if (sa !== sb) { return sa - sb; }
                    return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
                });
                const runtimeRows = sortedRuntimes.map(rt => buildRuntimeRow(rt)).join('');
                const hostPickerHtml = buildHostPickerHtml(ws);
                const hasActiveWindow = ws.runtimes.some(r => r.windowId && r.status === 'Local');
                const cardClass = hasActiveWindow ? 'workspace-card' : 'workspace-card workspace-card-inactive';
                const displayPath = ws.directoryPath.startsWith(os.homedir())
                    ? '~' + ws.directoryPath.slice(os.homedir().length)
                    : ws.directoryPath;
                return `
                <div class="${cardClass}" data-workspace-id="${escapeHtml(ws.id)}">
                    <div class="workspace-header">
                        <span class="workspace-name">&#x1F5C2;&#xFE0F; ${escapeHtml(displayPath)}</span>
                        <div class="workspace-header-right">
                            <button class="workspace-add-remote-btn" data-workspace-id="${escapeHtml(ws.id)}" title="Add Remote">
                                +
                            </button>
                            ${!hasActiveWindow ? `<button class="workspace-delete-btn" data-workspace-id="${escapeHtml(ws.id)}" title="Remove Workspace">✕</button>` : ''}
                        </div>
                    </div>
                    <div class="workspace-runtimes">
                        ${runtimeRows}
                    </div>
                    <div class="workspace-host-picker" id="host-picker-${escapeHtml(ws.id)}" style="display:none;">
                        ${hostPickerHtml}
                    </div>
                </div>`;
            }).join('')
            : '<p class="empty-message">No active sessions</p>';


        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Workspaces</title>
    <style>
        ${this._getCommonStyles(codiconsFontUri)}
        .file-browser {
            border-top: 1px solid var(--vscode-panel-border);
        }
        .file-nav-bar {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .file-nav-btn {
            padding: 0 4px;
            font-size: 14px;
            line-height: 18px;
            flex-shrink: 0;
            background: none;
            color: var(--vscode-descriptionForeground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        .file-nav-btn:hover:not(:disabled) {
            color: var(--vscode-foreground);
            background: var(--vscode-list-hoverBackground);
        }
        .file-nav-btn:disabled {
            opacity: 0.4;
            cursor: default;
        }
        .file-stop-btn {
            padding: 2px 6px;
            font-size: 10px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-errorForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }
        .file-stop-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .file-breadcrumbs {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 2px;
            font-size: 11px;
            flex: 1;
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
        }
        .breadcrumb-seg {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            padding: 1px 2px;
            border-radius: 2px;
        }
        .breadcrumb-root {
        }
        .breadcrumb-seg:hover {
            text-decoration: underline;
        }
        .breadcrumb-sep {
            color: var(--vscode-descriptionForeground);
        }
        .file-list {
            max-height: 260px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .file-entry {
            display: flex;
            align-items: center;
            padding: 3px 8px;
            font-size: 11px;
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 6px;
        }
        .file-entry:last-child {
            border-bottom: none;
        }
        .file-entry.dir {
            cursor: pointer;
        }
        .file-entry.dir:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .file-icon {
            flex-shrink: 0;
            width: 14px;
            text-align: center;
        }
        .file-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-size {
            flex-shrink: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }
        .file-status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 0;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .file-status.error {
            color: var(--vscode-errorForeground);
        }
        .file-status:empty {
            display: none;
        }
        .empty-message {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 16px 0;
        }
        .refresh-btn {
            padding: 2px 8px;
            font-size: 11px;
            margin: 0;
        }
        .tab-header {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 6px;
            gap: 4px;
        }
        .workspace-card {
            margin: 6px 0;
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid var(--vscode-panel-border);
        }
        .workspace-card-inactive {
            opacity: 0.6;
        }
        .workspace-card-inactive .workspace-header {
            background: var(--vscode-list-hoverBackground);
        }
        .workspace-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 8px;
            font-weight: 600;
            letter-spacing: 0.5px;
            background: var(--vscode-sideBarSectionHeader-background, var(--vscode-list-hoverBackground));
            color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
        }
        .workspace-name {
            display: flex;
            align-items: center;
            gap: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .workspace-header-right {
            display: flex;
            gap: 2px;
            flex-shrink: 0;
        }
        .workspace-add-remote-btn {
            margin: 0;
            padding: 2px 4px;
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            border-radius: 3px;
            font-size: 11px;
        }
        .workspace-add-remote-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        .workspace-delete-btn {
            margin: 0;
            padding: 2px 4px;
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            border-radius: 3px;
            font-size: 10px;
            opacity: 0.6;
        }
        .workspace-delete-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-errorForeground);
            opacity: 1;
        }
        .runtime-entry {
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .runtime-entry:last-child {
            border-bottom: none;
        }
        .runtime-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .runtime-name {
            font-weight: 600;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
            flex: 1;
        }
        .runtime-header-right {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }
        .runtime-details {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 2px 8px 4px 8px;
        }
        .status-icon {
            display: inline-block;
        }
        .status-flash {
            animation: flash 1s ease-in-out infinite;
        }
        @keyframes flash {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .workspace-host-picker {
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
            padding: 4px 0;
        }
        .host-picker-item {
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .host-picker-item:last-child {
            border-bottom: none;
        }
        .host-picker-row {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            cursor: pointer;
            font-size: 12px;
        }
        .host-picker-row:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .host-picker-chevron {
            font-size: 10px;
            transition: transform 0.15s;
        }
        .host-picker-chevron.expanded {
            transform: rotate(90deg);
        }
        .host-picker-name {
            font-weight: 500;
        }
        .host-picker-detail {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-left: auto;
        }
        .host-picker-form {
            padding: 4px 8px 8px 20px;
        }
        .session-badge {
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-left: 4px;
            vertical-align: middle;
        }
        .session-job-id {
            font-weight: 400;
            color: var(--vscode-descriptionForeground);
        }
        .session-detail {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .session-detail .codicon {
            font-size: 10px;
            margin-right: 2px;
            margin-left: 4px;
        }
        .session-detail .codicon:first-child {
            margin-left: 0;
        }
        .session-error {
            font-size: 10px;
            color: var(--vscode-errorForeground);
            white-space: normal;
            margin-top: 2px;
        }
        .session-countdown {
            display: block;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .session-countdown.countdown-warning {
            color: var(--vscode-editorWarning-foreground, #cca700);
        }
        .session-countdown.countdown-critical {
            color: var(--vscode-errorForeground);
        }
        .session-action-btn, .remove-session-btn {
            margin: 0;
            padding: 2px 4px;
            font-size: 11px;
            flex-shrink: 0;
            background: none;
            color: var(--vscode-descriptionForeground);
            border: none;
            cursor: pointer;
            border-radius: 3px;
        }
        .session-action-btn .codicon {
            font-size: 11px;
        }
        .session-action-btn:hover:not(:disabled), .remove-session-btn:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-errorForeground);
        }
        .session-action-btn:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .session-action-spinner {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .script-preview-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--vscode-editor-background);
            z-index: 100;
            padding: 10px;
            overflow-y: auto;
            flex-direction: column;
        }
        .script-preview-overlay.visible {
            display: flex;
        }
        .script-preview-header {
            font-weight: 600;
            font-size: 13px;
            margin-bottom: 8px;
        }
        .script-preview-host {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .script-preview-code {
            flex: 1;
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 9px;
            line-height: 1.3;
            white-space: pre;
            overflow: auto;
            color: var(--vscode-editor-foreground);
        }
        .script-preview-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
        }
        .script-preview-actions button {
            flex: 1;
            margin: 0;
        }
        .cancel-preview-btn {
            background: var(--vscode-button-secondaryBackground) !important;
            color: var(--vscode-button-secondaryForeground) !important;
        }
        .cancel-preview-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground) !important;
        }
        .auth-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 8px;
            margin-bottom: 8px;
            border-radius: 4px;
            font-size: 11px;
            background: var(--vscode-list-hoverBackground);
        }
        .auth-bar.signed-in {
            border-left: 3px solid var(--vscode-charts-green, #89d185);
        }
        .auth-bar.signed-out {
            border-left: 3px solid var(--vscode-charts-yellow, #cca700);
        }
        .auth-bar-info {
            display: flex;
            align-items: center;
            gap: 6px;
            overflow: hidden;
        }
        .auth-bar-info .codicon {
            flex-shrink: 0;
            font-size: 14px;
        }
        .auth-bar-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .auth-bar-btn {
            margin: 0;
            padding: 2px 8px;
            font-size: 10px;
            flex-shrink: 0;
        }
    </style>
</head>
<body>
    <div id="auth-bar" class="auth-bar ${this._devTunnelAccount ? 'signed-in' : 'signed-out'}">
        <div class="auth-bar-info">
            ${this._devTunnelAccount ? '&#x2705;' : '&#x26A0;'}
            <span id="auth-bar-label" class="auth-bar-label">${this._devTunnelAccount ? escapeHtml(this._devTunnelAccount) : 'Not signed in to Dev Tunnels'}</span>
        </div>
        ${this._devTunnelAccount
            ? '<button id="auth-bar-switch-btn" class="auth-bar-btn">Switch</button>'
            : '<button id="auth-bar-sign-in-btn" class="auth-bar-btn">Sign In</button>'}
    </div>

    <p class="description">Take your workspace into any runtime</p>

    <div class="tab-header">
        <button id="refresh-sessions-btn" class="refresh-btn" title="Refresh Sessions">&#x21BB;</button>
    </div>
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

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // Live countdown timer for active runtimes
        function updateCountdowns() {
            document.querySelectorAll('.session-countdown[data-deadline]').forEach(el => {
                const deadline = parseInt(el.getAttribute('data-deadline'), 10);
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    el.textContent = '⏱ expired';
                    el.className = 'session-countdown countdown-critical';
                } else {
                    const totalSec = Math.floor(remaining / 1000);
                    const hrs = Math.floor(totalSec / 3600);
                    const mins = Math.floor((totalSec % 3600) / 60);
                    const secs = totalSec % 60;
                    const pad = (n) => String(n).padStart(2, '0');
                    const timeStr = hrs > 0 ? hrs + ':' + pad(mins) + ':' + pad(secs) : pad(mins) + ':' + pad(secs);
                    el.textContent = '⏱ ' + timeStr + ' remaining';
                    const totalMin = totalSec / 60;
                    if (totalMin <= 5) {
                        el.className = 'session-countdown countdown-critical';
                    } else if (totalMin <= 15) {
                        el.className = 'session-countdown countdown-warning';
                    } else {
                        el.className = 'session-countdown';
                    }
                }
            });
        }
        updateCountdowns();
        setInterval(updateCountdowns, 1000);

        try {
        document.getElementById('refresh-sessions-btn')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });


        // Auth bar buttons
        function bindAuthBarButtons() {
            const signInBtn = document.getElementById('auth-bar-sign-in-btn');
            if (signInBtn) {
                signInBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'devTunnelSignIn' });
                });
            }
            const switchBtn = document.getElementById('auth-bar-switch-btn');
            if (switchBtn) {
                switchBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'devTunnelSwitch' });
                });
            }
        }
        bindAuthBarButtons();

        // File browser history per host: { back: string[], forward: string[], current: string|null, loading: bool }
        const fileHistory = {};
        function getHistory(host) {
            if (!fileHistory[host]) { fileHistory[host] = { back: [], forward: [], current: null, loading: false }; }
            return fileHistory[host];
        }
        function updateNavButtons(host) {
            const h = getHistory(host);
            const backBtn = document.querySelector('.file-back-btn[data-host="' + host + '"]');
            const fwdBtn = document.querySelector('.file-forward-btn[data-host="' + host + '"]');
            if (backBtn) { backBtn.disabled = h.back.length === 0; }
            if (fwdBtn) { fwdBtn.disabled = h.forward.length === 0; }
        }
        function navigateTo(host, path, addToHistory) {
            const h = getHistory(host);
            if (addToHistory && h.current) {
                h.back.push(h.current);
                h.forward = [];
            }
            h.current = path;
            h.loading = true;
            updateNavButtons(host);
            vscode.postMessage({ type: 'browseDir', host: host, path: path });
        }

        // File browser accordion (only one open at a time)
        document.querySelectorAll('.file-host-row').forEach(row => {
            row.addEventListener('click', () => {
                const host = row.getAttribute('data-host');
                const browser = document.getElementById('file-browser-' + host);
                if (browser) {
                    const isOpening = browser.style.display === 'none';
                    document.querySelectorAll('.file-browser').forEach(b => b.style.display = 'none');
                    document.querySelectorAll('.file-host-row').forEach(r => r.classList.remove('expanded'));
                    if (isOpening) {
                        browser.style.display = 'block';
                        row.classList.add('expanded');
                        navigateTo(host, '~', false);
                    }
                }
            });
        });

        // Back/forward buttons
        document.querySelectorAll('.file-back-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                const h = getHistory(host);
                if (h.back.length > 0) {
                    h.forward.push(h.current);
                    h.current = h.back.pop();
                    h.loading = true;
                    updateNavButtons(host);
                    vscode.postMessage({ type: 'browseDir', host: host, path: h.current });
                }
            });
        });

        document.querySelectorAll('.file-forward-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                const h = getHistory(host);
                if (h.forward.length > 0) {
                    h.back.push(h.current);
                    h.current = h.forward.pop();
                    h.loading = true;
                    updateNavButtons(host);
                    vscode.postMessage({ type: 'browseDir', host: host, path: h.current });
                }
            });
        });

        // Add click handlers to submit job buttons (workspace host picker only)
        document.querySelectorAll('.submit-job-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                const wsId = btn.getAttribute('data-workspace-id');
                const form = btn.closest('.host-picker-form');
                if (!form) { return; }
                const cpus = form.querySelector('[data-field="cpus"]').value;
                const memory = form.querySelector('[data-field="memory"]').value;
                const gpu = form.querySelector('[data-field="gpu"]').value;
                const wallTime = form.querySelector('[data-field="wallTime"]').value;
                const queue = form.querySelector('[data-field="queue"]').value;
                const allocation = form.querySelector('[data-field="allocation"]').value;
                vscode.postMessage({ type: 'addRuntime', host: host, cpus: cpus, memory: memory, gpu: gpu, wallTime: wallTime, queue: queue, allocation: allocation, workspaceId: wsId });
            });
        });

        // Workspace add-remote button: toggle host picker
        document.querySelectorAll('.workspace-add-remote-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wsId = btn.getAttribute('data-workspace-id');
                const picker = document.getElementById('host-picker-' + wsId);
                if (picker) {
                    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
                }
            });
        });

        // Host picker row: toggle form + trigger queryAssociations
        document.querySelectorAll('.host-picker-row').forEach(row => {
            row.addEventListener('click', () => {
                const host = row.getAttribute('data-host');
                const wsId = row.getAttribute('data-workspace-id');
                const formId = 'host-form-' + wsId + '-' + host;
                const form = document.getElementById(formId);
                const chevron = row.querySelector('.host-picker-chevron');
                if (!form) { return; }
                const isExpanding = form.style.display === 'none';
                form.style.display = isExpanding ? 'block' : 'none';
                if (chevron) { chevron.classList.toggle('expanded', isExpanding); }
                if (isExpanding) {
                    form.querySelector('.job-form-loading').style.display = 'flex';
                    form.querySelector('.job-form-fields').style.display = 'none';
                    form.querySelector('.job-form-error').style.display = 'none';
                    vscode.postMessage({ type: 'queryAssociations', host: host });
                }
            });
        });

        // Helper: disable all action buttons in a runtime card and show spinner
        function disableSessionActions(sessionId) {
            const entry = document.querySelector('.runtime-entry[data-session-id="' + sessionId + '"]');
            if (!entry) { return; }
            const right = entry.querySelector('.runtime-header-right');
            if (!right) { return; }
            right.querySelectorAll('.session-action-btn, .remove-session-btn').forEach(b => b.disabled = true);
            // Insert spinner before the first button if not already present
            if (!right.querySelector('.session-action-spinner')) {
                const spinner = document.createElement('i');
                spinner.className = 'codicon codicon-loading codicon-modifier-spin session-action-spinner';
                const firstBtn = right.querySelector('.session-action-btn, .remove-session-btn');
                if (firstBtn) { right.insertBefore(spinner, firstBtn); }
            }
        }

        // Add click handlers to session connect buttons
        document.querySelectorAll('.connect-session-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                vscode.postMessage({ type: 'connectSsh', host: host });
            });
        });

        // Add click handlers to session switch buttons (extracted for re-attachment after incremental updates)
        function attachSwitchHandlers() {
            document.querySelectorAll('.switch-btn').forEach(btn => {
                // Remove old listener by cloning to avoid duplicate handlers
                const newBtn = btn.cloneNode(true);
                btn.parentNode.replaceChild(newBtn, btn);
                newBtn.addEventListener('click', () => {
                    const sessionId = newBtn.getAttribute('data-session-id');
                    const direction = newBtn.getAttribute('data-direction');
                    disableSessionActions(sessionId);
                    if (direction === 'local-window') {
                        vscode.postMessage({ type: 'switchToWindow', sessionId: sessionId });
                    } else if (direction === 'remote') {
                        vscode.postMessage({ type: 'switchToRemote', sessionId: sessionId });
                    } else {
                        vscode.postMessage({ type: 'switchToLocal', sessionId: sessionId });
                    }
                });
            });
        }
        attachSwitchHandlers();

        // Add click handlers to session remove buttons (extracted for re-attachment after incremental updates)
        function attachRemoveHandlers() {
            document.querySelectorAll('.remove-session-btn').forEach(btn => {
                // Remove old listener by cloning to avoid duplicate handlers
                const newBtn = btn.cloneNode(true);
                btn.parentNode.replaceChild(newBtn, btn);
                newBtn.addEventListener('click', () => {
                    const sessionId = newBtn.getAttribute('data-session-id');
                    disableSessionActions(sessionId);
                    vscode.postMessage({ type: 'removeSession', sessionId: sessionId });
                });
            });
        }
        attachRemoveHandlers();

        // Add click handlers to workspace delete buttons
        function attachWorkspaceDeleteHandlers() {
            document.querySelectorAll('.workspace-delete-btn').forEach(btn => {
                const newBtn = btn.cloneNode(true);
                btn.parentNode.replaceChild(newBtn, btn);
                newBtn.addEventListener('click', () => {
                    const workspaceId = newBtn.getAttribute('data-workspace-id');
                    vscode.postMessage({ type: 'removeWorkspace', workspaceId: workspaceId });
                });
            });
        }
        attachWorkspaceDeleteHandlers();

        // Script preview state
        let previewSessionId = null;

        document.getElementById('confirm-preview-btn')?.addEventListener('click', () => {
            if (previewSessionId) {
                vscode.postMessage({ type: 'confirmJob', sessionId: previewSessionId });
                document.getElementById('script-preview-overlay')?.classList.remove('visible');
                previewSessionId = null;
            }
        });

        document.getElementById('cancel-preview-btn')?.addEventListener('click', () => {
            if (previewSessionId) {
                vscode.postMessage({ type: 'cancelJob', sessionId: previewSessionId });
            }
            document.getElementById('script-preview-overlay')?.classList.remove('visible');
            previewSessionId = null;
        });

        // Handle messages from the extension (e.g. associations data, script preview)
        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'authState') {
                const bar = document.getElementById('auth-bar');
                if (msg.account) {
                    bar.className = 'auth-bar signed-in';
                    bar.innerHTML = '<div class="auth-bar-info">&#x2705;<span id="auth-bar-label" class="auth-bar-label">' + msg.account + '</span></div><button id="auth-bar-switch-btn" class="auth-bar-btn">Switch</button>';
                } else {
                    bar.className = 'auth-bar signed-out';
                    bar.innerHTML = '<div class="auth-bar-info">&#x26A0;<span id="auth-bar-label" class="auth-bar-label">Not signed in to Dev Tunnels</span></div><button id="auth-bar-sign-in-btn" class="auth-bar-btn">Sign In</button>';
                }
                bindAuthBarButtons();
                return;
            }

            if (msg.type === 'scriptPreview') {
                previewSessionId = msg.sessionId;
                document.getElementById('script-preview-host').textContent = 'Host: ' + msg.host;
                document.getElementById('script-preview-code').textContent = msg.script;
                document.getElementById('script-preview-overlay').classList.add('visible');
                return;
            }

            if (msg.type === 'scriptPreviewDismissed') {
                document.getElementById('script-preview-overlay').classList.remove('visible');
                previewSessionId = null;
                return;
            }

            if (msg.type === 'associationsCancelled') {
                // Update all forms for this host (Servers panel + host picker forms)
                const allForms = getAllFormsForHost(msg.host);
                allForms.forEach(form => {
                    form.querySelector('.job-form-loading').style.display = 'none';
                });
                // Reset to collapsed state — user can click to retry
                return;
            }

            if (msg.type === 'associationsError') {
                const allForms = getAllFormsForHost(msg.host);
                allForms.forEach(form => {
                    form.querySelector('.job-form-loading').style.display = 'none';
                    form.querySelector('.job-form-error').style.display = 'flex';
                    form.querySelector('.job-form-error-text').textContent = 'Failed to fetch partitions: ' + msg.error;
                });
                return;
            }

            // Helper: find all host-picker job forms for a given host name (workspaces view only)
            function getAllFormsForHost(host) {
                const forms = [];
                document.querySelectorAll('.host-picker-form').forEach(form => {
                    const allocSelect = form.querySelector('[data-field="allocation"][data-host="' + host + '"]');
                    if (allocSelect) { forms.push(form); }
                });
                return forms;
            }

            if (msg.type === 'associations') {
                const host = msg.host;
                const partitions = msg.partitions; // { name: { accounts, nodes, maxCpus, maxGpus } }
                const allForms = getAllFormsForHost(host);

                // Collect unique accounts across all partitions
                const allPartNames = Object.keys(partitions);
                const accountSet = new Set();
                for (const info of Object.values(partitions)) {
                    for (const acct of info.accounts) { accountSet.add(acct); }
                }
                const accounts = Array.from(accountSet).sort();

                allForms.forEach(form => {
                    form.querySelector('.job-form-loading').style.display = 'none';
                    form.querySelector('.job-form-error').style.display = 'none';
                    form.querySelector('.job-form-fields').style.display = 'block';

                    const allocSelect = form.querySelector('[data-field="allocation"]');
                    const partSelect = form.querySelector('[data-field="queue"]');

                    // Populate Allocation dropdown (independent of partition selection)
                    allocSelect.innerHTML = '';
                    if (accounts.length > 0) {
                        accounts.forEach((acct, i) => {
                            const opt = document.createElement('option');
                            opt.value = acct;
                            opt.textContent = acct;
                            if (i === 0) { opt.selected = true; }
                            allocSelect.appendChild(opt);
                        });
                    } else {
                        allocSelect.innerHTML = '<option value="">N/A</option>';
                        allocSelect.disabled = true;
                    }

                    // Always show all partitions — no filtering by account
                    function updatePartitions() {
                        partSelect.innerHTML = '';
                        allPartNames.forEach((name, i) => {
                            const info = partitions[name];
                            const label = info.maxGpus > 0
                                ? name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs, ' + info.maxGpus + ' GPUs)'
                                : name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs)';
                            const opt = document.createElement('option');
                            opt.value = name;
                            opt.textContent = label;
                            if (i === 0) { opt.selected = true; }
                            partSelect.appendChild(opt);
                        });
                    }

                    allocSelect.addEventListener('change', updatePartitions);
                    updatePartitions(); // populate for initial selection
                });
            }

            if (msg.type === 'browseCancelled') {
                const host = msg.host;
                const h = getHistory(host);
                h.loading = false;
                const statusEl = document.getElementById('file-status-' + host);
                const listEl = document.getElementById('file-list-' + host);
                if (statusEl) { statusEl.className = 'file-status error'; statusEl.innerHTML = 'Cancelled'; }
                if (listEl) { listEl.innerHTML = ''; }
                return;
            }

            if (msg.type === 'fileListing') {
                const host = msg.host;
                const breadcrumbsEl = document.getElementById('file-breadcrumbs-' + host);
                const statusEl = document.getElementById('file-status-' + host);
                const listEl = document.getElementById('file-list-' + host);
                if (!breadcrumbsEl || !statusEl || !listEl) { return; }
                const h = getHistory(host);

                if (msg.loading) {
                    if (!breadcrumbsEl.innerHTML || breadcrumbsEl.querySelector('.skeleton')) {
                        breadcrumbsEl.innerHTML = '<span class="skeleton skeleton-text" style="width:120px"></span>';
                    }
                    statusEl.className = 'file-status';
                    statusEl.innerHTML = '<div class="spinner"></div>Loading...<button class="file-stop-btn" data-host="' + host + '">Stop</button>';
                    listEl.innerHTML = '';
                    // Attach stop button handler
                    const stopBtn = statusEl.querySelector('.file-stop-btn');
                    if (stopBtn) {
                        stopBtn.addEventListener('click', () => {
                            vscode.postMessage({ type: 'cancelBrowse', host: host });
                        });
                    }
                    return;
                }

                h.loading = false;
                statusEl.className = 'file-status';
                statusEl.innerHTML = '';

                if (msg.error) {
                    statusEl.className = 'file-status error';
                    statusEl.innerHTML = 'Error: ' + msg.error;
                    listEl.innerHTML = '';
                    return;
                }

                // Update current path in history to resolved path
                const pathStr = msg.path;
                h.current = pathStr;

                // Build breadcrumbs with server icon for root
                const segments = pathStr.split('/').filter(s => s.length > 0);
                let bc = '<span class="breadcrumb-seg breadcrumb-root" data-path="/" data-host="' + host + '" title="/">~</span>';
                let cumulative = '';
                segments.forEach(seg => {
                    cumulative += '/' + seg;
                    bc += '<span class="breadcrumb-sep">/</span>';
                    bc += '<span class="breadcrumb-seg" data-path="' + cumulative + '" data-host="' + host + '">' + seg + '</span>';
                });
                breadcrumbsEl.innerHTML = bc;

                // Attach breadcrumb click handlers
                breadcrumbsEl.querySelectorAll('.breadcrumb-seg').forEach(seg => {
                    seg.addEventListener('click', (e) => {
                        e.stopPropagation();
                        navigateTo(host, seg.getAttribute('data-path'), true);
                    });
                });

                updateNavButtons(host);

                // Build file list
                if (msg.entries.length === 0) {
                    statusEl.innerHTML = 'Empty directory';
                    listEl.innerHTML = '';
                    return;
                }

                listEl.innerHTML = msg.entries.map(entry => {
                    const icon = entry.isDir ? '&#128193;' : '&#128196;';
                    const cls = entry.isDir ? 'file-entry dir' : 'file-entry';
                    const entryPath = pathStr + (pathStr.endsWith('/') ? '' : '/') + entry.name;
                    return '<div class="' + cls + '"'
                        + (entry.isDir ? ' data-host="' + host + '" data-path="' + entryPath + '"' : '')
                        + '><span class="file-icon">' + icon + '</span>'
                        + '<span class="file-name">' + entry.name + '</span>'
                        + '<span class="file-size">' + entry.size + '</span></div>';
                }).join('');

                // Attach folder click handlers
                listEl.querySelectorAll('.file-entry.dir').forEach(entry => {
                    entry.addEventListener('click', () => {
                        navigateTo(host, entry.getAttribute('data-path'), true);
                    });
                });
            }

            if (msg.type === 'updateRuntimes') {
                function escapeHtml(str) {
                    const div = document.createElement('div');
                    div.textContent = str;
                    return div.innerHTML;
                }
                const updates = msg.updates;
                for (const wsUpdate of updates) {
                    for (const rt of wsUpdate.runtimes) {
                        const entry = document.querySelector('.runtime-entry[data-session-id="' + rt.id + '"]');
                        if (!entry) { continue; }

                        // Determine new status icon
                        // Blue = has an active VS Code window connected (any window)
                        let iconHtml;
                        if ((rt.status === 'Local' && rt.hasActiveWindow) || rt.isActiveInThisWindow || (rt.status === 'Active' && rt.hasActiveWindow)) {
                            iconHtml = '<span class="status-icon">🔵</span>';
                        } else if (rt.status === 'Active') {
                            iconHtml = '<span class="status-icon">🟢</span>';
                        } else if (rt.status === 'Submitting') {
                            iconHtml = '<span class="status-icon status-flash">🟡</span>';
                        } else if (rt.status === 'Pending') {
                            iconHtml = '<span class="status-icon">🟡</span>';
                        } else {
                            iconHtml = '<span class="status-icon">⚪</span>';
                        }

                        // Update runtime name (icon + name)
                        const nameSpan = entry.querySelector('.runtime-name');
                        if (nameSpan) {
                            const displayName = rt.status === 'Local' ? 'Local' : escapeHtml(rt.host);
                            nameSpan.innerHTML = iconHtml + ' ' + displayName;
                        }

                        // Update action buttons
                        const headerRight = entry.querySelector('.runtime-header-right');
                        if (headerRight) {
                            if (rt.isThisWindow || rt.isActiveInThisWindow) {
                                headerRight.innerHTML = '<span class="session-badge">this window</span>';
                            } else {
                                const switchDirection = rt.status === 'Local' ? 'local-window' : 'remote';
                                const switchBtn = '<button class="session-action-btn switch-btn" data-session-id="' + rt.id + '" data-direction="' + switchDirection + '" title="Switch">&#x21C4;</button>';
                                const removeBtn = '<button class="remove-session-btn" data-session-id="' + rt.id + '" title="Remove">✕</button>';
                                headerRight.innerHTML = switchBtn + removeBtn;
                            }
                        }

                        // Update detail section for non-local runtimes
                        const existingDetails = entry.querySelector('.runtime-details');
                        if (rt.status !== 'Local') {
                            const wtParts = rt.wallTime.split(':').map(Number);
                            const wtTotalMin = (wtParts[0] || 0) * 60 + (wtParts[1] || 0);
                            const wallTimeShort = wtTotalMin >= 1440 ? Math.floor(wtTotalMin / 1440) + 'd' : wtTotalMin >= 60 ? Math.floor(wtTotalMin / 60) + 'hr' : wtTotalMin + 'min';
                            const gpuPart = rt.gpu !== 'None' ? ' ' + escapeHtml(rt.gpu) : '';
                            const line1 = escapeHtml(rt.queue) + ' ' + escapeHtml(rt.allocation) + ' ' + rt.cpus + ' ' + rt.memory + gpuPart + ' ' + wallTimeShort;
                            let line2 = '';
                            if (rt.status === 'Active') {
                                const deadlineMs = new Date(rt.submittedAt).getTime() + wtTotalMin * 60000;
                                const countdownSpan = '<span class="session-countdown" data-deadline="' + deadlineMs + '"></span>';
                                line2 = rt.tunnelUrl ? countdownSpan + ' ' + escapeHtml(rt.tunnelUrl) : countdownSpan + ' setting up tunnel...';
                            } else if (rt.status === 'Submitting') {
                                line2 = 'submitting job...';
                            } else if (rt.status === 'Pending') {
                                line2 = 'queued, waiting for resources...';
                            } else if (rt.status === 'Failed') {
                                line2 = rt.errorMessage ? 'failed: ' + escapeHtml(rt.errorMessage) : 'failed';
                            } else if (rt.status === 'Completed') {
                                line2 = 'completed';
                            }
                            const detailInner = '<span class="session-detail">' + line1 + '</span>'
                                + '<span class="session-detail session-status-line">' + line2 + '</span>';

                            if (existingDetails) {
                                existingDetails.innerHTML = detailInner;
                            } else {
                                const div = document.createElement('div');
                                div.className = 'runtime-details';
                                div.innerHTML = detailInner;
                                entry.appendChild(div);
                            }
                        } else if (existingDetails) {
                            existingDetails.remove();
                        }
                    }
                }

                // Re-attach event listeners for any new buttons injected during the update
                attachSwitchHandlers();
                attachRemoveHandlers();
                attachWorkspaceDeleteHandlers();
            }
        });
        } catch (err) { console.error('[cybershuttle] Webview init error:', err); }
    </script>
</body>
</html>`;
    }

    /**
     * Generate the HTML for the SERVERS webview.
     * Contains: SSH host list with expandable job forms, Local test button, Add SSH button, Refresh button.
     */
    private _getServersHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicons', 'codicon.ttf'));

        // Get SSH hosts from config
        const sshHosts = this.getSshHosts();
        const hostsHtml = sshHosts.length > 0
            ? sshHosts.map(host => `
                <div class="ssh-host">
                    <div class="ssh-host-row${this._expandedHost === host.name ? ' expanded' : ''}" data-host="${escapeHtml(host.name)}">
                        <div class="host-info">
                            <span class="host-name">${escapeHtml(host.name)}</span>
                            ${host.hostname ? `<span class="host-detail">${host.user ? `${escapeHtml(host.user)}@` : ''}${escapeHtml(host.hostname)}</span>` : ''}
                        </div>
                        <span class="chevron">&#x203A;</span>
                    </div>
                    <div class="job-form" id="job-form-${escapeHtml(host.name)}" style="display:${this._expandedHost === host.name ? 'block' : 'none'};">
                        <div class="job-form-loading" style="display:${this._expandedHost === host.name && this._associationsCts.has(host.name) ? 'flex' : 'none'};"><div class="spinner"></div>Fetching partitions...<button class="job-form-stop-btn" data-host="${escapeHtml(host.name)}">Stop</button></div>
                        <div class="job-form-error" style="display:none;"><span class="job-form-error-text"></span><button class="job-form-retry-btn" data-host="${escapeHtml(host.name)}">Retry</button></div>
                        <div class="job-form-fields">
                            <div class="form-row">
                                <label>CPUs</label>
                                <select class="form-select" data-field="cpus">
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    <option value="4">4</option>
                                    <option value="8">8</option>
                                    <option value="16">16</option>
                                    <option value="32">32</option>
                                    <option value="64">64</option>
                                </select>
                            </div>
                            <div class="form-row">
                                <label>Memory</label>
                                <select class="form-select" data-field="memory">
                                    <option value="1 GB">1 GB</option>
                                    <option value="2 GB">2 GB</option>
                                    <option value="4 GB">4 GB</option>
                                    <option value="8 GB">8 GB</option>
                                    <option value="16 GB">16 GB</option>
                                    <option value="32 GB">32 GB</option>
                                    <option value="64 GB">64 GB</option>
                                    <option value="128 GB">128 GB</option>
                                </select>
                            </div>
                            <div class="form-row">
                                <label>GPU</label>
                                <select class="form-select" data-field="gpu">
                                    <option value="None">None</option>
                                    <option value="NVIDIA A100">NVIDIA A100</option>
                                    <option value="NVIDIA V100">NVIDIA V100</option>
                                    <option value="NVIDIA T4">NVIDIA T4</option>
                                    <option value="NVIDIA A40">NVIDIA A40</option>
                                    <option value="NVIDIA H100">NVIDIA H100</option>
                                </select>
                            </div>
                            <div class="form-row">
                                <label>Wall Time</label>
                                <select class="form-select" data-field="wallTime">
                                    <option value="00:30:00">30 min</option>
                                    <option value="01:00:00">1 hour</option>
                                    <option value="02:00:00">2 hours</option>
                                    <option value="04:00:00">4 hours</option>
                                    <option value="08:00:00">8 hours</option>
                                    <option value="12:00:00">12 hours</option>
                                    <option value="24:00:00">24 hours</option>
                                </select>
                            </div>
                            <div class="form-row">
                                <label>Allocation</label>
                                <select class="form-select" data-field="allocation" data-host="${escapeHtml(host.name)}">
                                    <option value="">Loading...</option>
                                </select>
                            </div>
                            <div class="form-row">
                                <label>Partition</label>
                                <select class="form-select" data-field="queue" data-host="${escapeHtml(host.name)}">
                                    <option value="">Select allocation first</option>
                                </select>
                            </div>
                            <button class="submit-job-btn" data-host="${escapeHtml(host.name)}">Launch</button>
                        </div>
                    </div>
                </div>
            `).join('')
            : '<p class="empty-message">No SSH hosts found in ~/.ssh/config</p>';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Servers</title>
    <style>
        ${this._getCommonStyles(codiconsFontUri)}
    </style>
</head>
<body>
    <div class="servers-actions" style="display:flex;gap:4px;margin-bottom:8px;">
        <button id="test-local-btn" class="refresh-btn" title="Test Local (linkspan)">&#x2756; Local</button>
        <button id="add-ssh-btn" class="refresh-btn" title="Add SSH Host">+ Add</button>
        <button id="refresh-servers-btn" class="refresh-btn" title="Refresh Servers">&#x21BB;</button>
    </div>
    <div id="ssh-hosts">
        ${hostsHtml}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        try {

        document.getElementById('refresh-servers-btn')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        document.getElementById('add-ssh-btn')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'addSshHost' });
        });

        document.getElementById('test-local-btn')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'testLocal' });
        });

        // Add click handlers to host rows (accordion — only one open at a time)
        document.querySelectorAll('#ssh-hosts .ssh-host-row').forEach(row => {
            row.addEventListener('click', () => {
                const host = row.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (form) {
                    const isOpening = form.style.display === 'none';
                    // Collapse all open forms and reset chevrons
                    document.querySelectorAll('.job-form').forEach(f => f.style.display = 'none');
                    document.querySelectorAll('#ssh-hosts .ssh-host-row').forEach(r => r.classList.remove('expanded'));
                    if (isOpening) {
                        form.style.display = 'block';
                        row.classList.add('expanded');
                        form.querySelector('.job-form-loading').style.display = 'flex';
                        form.querySelector('.job-form-fields').style.display = 'none';
                        form.querySelector('.job-form-error').style.display = 'none';
                        vscode.postMessage({ type: 'expandHost', host: host });
                        vscode.postMessage({ type: 'queryAssociations', host: host });
                    } else {
                        vscode.postMessage({ type: 'expandHost', host: null });
                    }
                }
            });
        });

        // Retry buttons
        document.querySelectorAll('.job-form-retry-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (form) {
                    form.querySelector('.job-form-loading').style.display = 'flex';
                    form.querySelector('.job-form-error').style.display = 'none';
                    vscode.postMessage({ type: 'queryAssociations', host: host });
                }
            });
        });

        // Stop (cancel associations) buttons
        document.querySelectorAll('.job-form-stop-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                vscode.postMessage({ type: 'cancelAssociations', host: host });
            });
        });

        // Submit job buttons (Servers panel only — no workspace context)
        document.querySelectorAll('.submit-job-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (!form) { return; }
                const cpus = form.querySelector('[data-field="cpus"]').value;
                const memory = form.querySelector('[data-field="memory"]').value;
                const gpu = form.querySelector('[data-field="gpu"]').value;
                const wallTime = form.querySelector('[data-field="wallTime"]').value;
                const queue = form.querySelector('[data-field="queue"]').value;
                const allocation = form.querySelector('[data-field="allocation"]').value;
                vscode.postMessage({ type: 'createJob', host: host, cpus: cpus, memory: memory, gpu: gpu, wallTime: wallTime, queue: queue, allocation: allocation });
            });
        });

        // Handle messages from the extension
        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'associationsCancelled') {
                const form = document.getElementById('job-form-' + msg.host);
                if (form) {
                    form.querySelector('.job-form-loading').style.display = 'none';
                }
                return;
            }

            if (msg.type === 'associationsError') {
                const form = document.getElementById('job-form-' + msg.host);
                if (form) {
                    form.querySelector('.job-form-loading').style.display = 'none';
                    form.querySelector('.job-form-error').style.display = 'flex';
                    form.querySelector('.job-form-error-text').textContent = 'Failed to fetch partitions: ' + msg.error;
                }
                return;
            }

            if (msg.type === 'associations') {
                const host = msg.host;
                const partitions = msg.partitions;
                const form = document.getElementById('job-form-' + host);
                if (!form) { return; }

                const allPartNames = Object.keys(partitions);
                const accountSet = new Set();
                for (const info of Object.values(partitions)) {
                    for (const acct of info.accounts) { accountSet.add(acct); }
                }
                const accounts = Array.from(accountSet).sort();

                form.querySelector('.job-form-loading').style.display = 'none';
                form.querySelector('.job-form-error').style.display = 'none';
                form.querySelector('.job-form-fields').style.display = 'block';

                const allocSelect = form.querySelector('[data-field="allocation"]');
                const partSelect = form.querySelector('[data-field="queue"]');

                allocSelect.innerHTML = '';
                if (accounts.length > 0) {
                    accounts.forEach((acct, i) => {
                        const opt = document.createElement('option');
                        opt.value = acct;
                        opt.textContent = acct;
                        if (i === 0) { opt.selected = true; }
                        allocSelect.appendChild(opt);
                    });
                } else {
                    allocSelect.innerHTML = '<option value="">N/A</option>';
                    allocSelect.disabled = true;
                }

                function updatePartitions() {
                    partSelect.innerHTML = '';
                    allPartNames.forEach((name, i) => {
                        const info = partitions[name];
                        const label = info.maxGpus > 0
                            ? name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs, ' + info.maxGpus + ' GPUs)'
                            : name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs)';
                        const opt = document.createElement('option');
                        opt.value = name;
                        opt.textContent = label;
                        if (i === 0) { opt.selected = true; }
                        partSelect.appendChild(opt);
                    });
                }

                allocSelect.addEventListener('change', updatePartitions);
                updatePartitions();
            }
        });
        } catch (err) { console.error('[cybershuttle] Servers webview init error:', err); }
    </script>
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

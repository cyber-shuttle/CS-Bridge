import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { TunnelCredentials } from './TunnelManager.js';

export interface LocalLinkspanInfo {
    pid: number;
    tunnelId: string;
    tunnelToken: string;
    tunnelUrl: string;
    sshPort: number;
    serverPort: number;
    logPort: number;
    workspacePath: string;
}

/**
 * Manages a local linkspan instance per workspace.
 * The local linkspan serves the workspace filesystem via SSH+SFTP
 * and creates a devtunnel so remote sessions can access it.
 *
 * Instances persist across VS Code reloads — the linkspan process keeps
 * running and is recovered on the next activation.
 */
export class LocalLinkspanManager {
    /** workspacePath -> running instance */
    private _instances: Map<string, LocalLinkspanInfo> = new Map();
    private _processes: Map<string, ChildProcess> = new Map();
    private _logSockets: Map<string, net.Socket> = new Map();
    private _logReconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private _logReconnectAttempts: Map<string, number> = new Map();
    private _ensureLocks: Map<string, Promise<LocalLinkspanInfo>> = new Map();
    private _stateFilePath: string;

    constructor(
        private readonly _outputChannel: { appendLine: (line: string) => void },
        private readonly _getLinkspanBin: () => Promise<string>,
        private readonly _getCredentials: () => Promise<TunnelCredentials>,
    ) {
        const csDir = path.join(os.homedir(), '.cybershuttle');
        if (!fs.existsSync(csDir)) {
            fs.mkdirSync(csDir, { recursive: true });
        }
        this._stateFilePath = path.join(csDir, 'local-linkspan-state.json');
    }

    /**
     * Recover running linkspan instances from a previous VS Code session.
     * Called once during activation.
     */
    recover(): void {
        const saved = this._loadState();
        for (const info of saved) {
            // Check if the process is still alive
            try {
                process.kill(info.pid, 0);
            } catch {
                this._outputChannel.appendLine(`[linkspan-local] Stale instance for ${info.workspacePath} (pid ${info.pid} dead), removing`);
                continue;
            }
            this._outputChannel.appendLine(`[linkspan-local] Recovered: ${info.workspacePath} (pid=${info.pid}, tunnel=${info.tunnelId}, ssh=${info.sshPort}, log=${info.logPort})`);
            this._instances.set(info.workspacePath, info);
            // Reconnect log stream
            this._connectLogStream(info.workspacePath, info.logPort);
            // Async health check — kill stale instances where PID was recycled by OS
            this._isHealthy(info).then(healthy => {
                if (!healthy) {
                    this._outputChannel.appendLine(`[linkspan-local] Recovered instance ${info.workspacePath} failed health check, removing`);
                    this.stop(info.workspacePath);
                }
            });
        }
        // Clean up dead entries from state file
        if (saved.length !== this._instances.size) {
            this._saveState();
        }
    }

    /**
     * Ensure a local linkspan is running for the given workspace.
     * Returns the tunnel info for remote sessions to connect to.
     */
    async ensure(workspacePath: string): Promise<LocalLinkspanInfo> {
        // Serialize concurrent calls for the same workspace to prevent double-start
        const pending = this._ensureLocks.get(workspacePath);
        if (pending) {
            return pending;
        }
        const promise = this._ensureImpl(workspacePath);
        this._ensureLocks.set(workspacePath, promise);
        try {
            return await promise;
        } finally {
            this._ensureLocks.delete(workspacePath);
        }
    }

    private async _ensureImpl(workspacePath: string): Promise<LocalLinkspanInfo> {
        const existing = this._instances.get(workspacePath);
        if (existing) {
            // Check if process is still alive
            try {
                process.kill(existing.pid, 0);
            } catch {
                // Process died, clean up and restart
                this._instances.delete(workspacePath);
                this._processes.delete(workspacePath);
                this._saveState();
                return this._start(workspacePath);
            }
            // PID alive — verify the HTTP server is actually responding
            if (await this._isHealthy(existing)) {
                return existing;
            }
            // Process alive but not healthy — give it a moment then retry
            this._outputChannel.appendLine(`[linkspan-local] ${workspacePath}: PID alive but health check failed, waiting...`);
            await new Promise(r => setTimeout(r, 3000));
            if (await this._isHealthy(existing)) {
                return existing;
            }
            // Still unhealthy — kill and restart
            this._outputChannel.appendLine(`[linkspan-local] ${workspacePath}: still unhealthy after retry, restarting`);
            this.stop(workspacePath);
            return this._start(workspacePath);
        }
        return this._start(workspacePath);
    }

    /**
     * Check if a running linkspan instance is healthy by hitting /api/v1/health.
     * Uses the local server port (not tunnel URL) for faster, more reliable checks.
     */
    private async _isHealthy(info: LocalLinkspanInfo): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(`http://127.0.0.1:${info.serverPort}/api/v1/health`, {
                signal: controller.signal,
            });
            clearTimeout(timeout);
            return resp.ok;
        } catch {
            return false;
        }
    }

    private async _start(workspacePath: string): Promise<LocalLinkspanInfo> {
        const linkspanBin = await this._getLinkspanBin();
        const creds = await this._getCredentials();
        const tunnelName = `ls-local-${Date.now()}`;
        const serverUrlLine = creds.serverUrl ? `\n      server_url: "${creds.serverUrl}"` : '';

        const workflowYaml = [
            `name: "cs-bridge-local-anchor"`,
            ``,
            `steps:`,
            `  - action: "tunnel.create"`,
            `    name: "Create local tunnel"`,
            `    params:`,
            `      provider: "${creds.provider}"`,
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
            `      log_port: "log_port"`,
        ].join('\n');

        this._outputChannel.appendLine(`[linkspan-local] Starting for ${workspacePath}`);
        const proc = spawn(linkspanBin, [
            '--port', '0',
            '--tunnel-auth-token', creds.authToken,
            '--workflow', '-',
        ], {
            cwd: workspacePath,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true, // Keep running after VS Code exits
        });

        // Unref so the child process doesn't prevent VS Code from exiting
        proc.unref();
        proc.stdin!.write(workflowYaml);
        proc.stdin!.end();

        const info = await new Promise<LocalLinkspanInfo>((resolve, reject) => {
            const captures: Record<string, string> = {};
            let serverPort = 0;
            let sshPort = 0;

            const timeout = setTimeout(() => {
                const missing: string[] = [];
                if (!sshPort) { missing.push('ssh_port'); }
                if (!serverPort) { missing.push('server_port'); }
                if (!captures.tunnel_id) { missing.push('tunnel_id'); }
                if (!captures.tunnel_url) { missing.push('tunnel_url'); }
                if (!captures.tunnel_token) { missing.push('tunnel_token'); }
                if (!captures.log_port) { missing.push('log_port'); }
                reject(new Error(`Local linkspan startup timed out (waiting for: ${missing.join(', ')})`));
            }, 60_000);

            const checkComplete = () => {
                if (captures.tunnel_id && captures.tunnel_url && captures.tunnel_token && captures.log_port && sshPort > 0 && serverPort > 0) {
                    clearTimeout(timeout);
                    resolve({
                        pid: proc.pid!,
                        tunnelId: captures.tunnel_id,
                        tunnelToken: captures.tunnel_token,
                        tunnelUrl: captures.tunnel_url,
                        sshPort,
                        serverPort,
                        logPort: parseInt(captures.log_port, 10),
                        workspacePath,
                    });
                }
            };

            const handleOutput = (data: Buffer) => {
                const text = data.toString();
                // Process line-by-line to handle multiple signals in one chunk
                for (const line of text.split('\n')) {
                    const sshMatch = line.match(/SSH server listening on [\d.]+:(\d+)/);
                    if (sshMatch) {
                        sshPort = parseInt(sshMatch[1], 10);
                        continue;
                    }
                    const listenMatch = line.match(/listening on [\d.]+:(\d+)/);
                    if (listenMatch) {
                        serverPort = parseInt(listenMatch[1], 10);
                    }
                    const capMatch = line.match(/workflow: captured (\S+) = (.+)/);
                    if (capMatch) {
                        captures[capMatch[1]] = capMatch[2].trim();
                    }
                }
                checkComplete();
            };

            proc.stderr!.on('data', handleOutput);
            proc.stdout!.on('data', handleOutput);
            proc.on('error', (err: Error) => {
                clearTimeout(timeout);
                reject(err);
            });
            proc.on('close', (code: number | null) => {
                if (!captures.tunnel_id) {
                    clearTimeout(timeout);
                    reject(new Error(`Local linkspan exited with code ${code}`));
                }
            });
        });

        this._processes.set(workspacePath, proc);
        this._instances.set(workspacePath, info);
        this._saveState();
        this._outputChannel.appendLine(`[linkspan-local] Ready: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}, log=${info.logPort}`);

        // Connect to the log stream socket for real-time output
        this._connectLogStream(workspacePath, info.logPort);
        return info;
    }

    private _connectLogStream(workspacePath: string, logPort: number): void {
        // Clear any pending reconnect timer
        const timer = this._logReconnectTimers.get(workspacePath);
        if (timer) {
            clearTimeout(timer);
            this._logReconnectTimers.delete(workspacePath);
        }

        // Close existing socket if any
        const existing = this._logSockets.get(workspacePath);
        if (existing) {
            existing.destroy();
            this._logSockets.delete(workspacePath);
        }

        // Don't connect if the instance is gone
        if (!this._instances.has(workspacePath)) {
            this._logReconnectAttempts.delete(workspacePath);
            return;
        }

        const sock = new net.Socket();
        sock.connect(logPort, '127.0.0.1', () => {
            this._outputChannel.appendLine(`[linkspan-local] connected to log stream (port ${logPort})`);
            this._logReconnectAttempts.delete(workspacePath); // Reset backoff on success
        });

        sock.on('data', (data: Buffer) => {
            const text = data.toString();
            for (const line of text.split('\n')) {
                if (line.trim()) {
                    this._outputChannel.appendLine(`[linkspan-local] ${line}`);
                }
            }
        });

        sock.on('error', () => {
            // Will try to reconnect below in 'close' handler
        });

        sock.on('close', () => {
            this._logSockets.delete(workspacePath);
            // Auto-reconnect with exponential backoff (5s, 10s, 20s, 40s, max 60s)
            if (this._instances.has(workspacePath)) {
                const attempts = this._logReconnectAttempts.get(workspacePath) || 0;
                const delay = Math.min(5000 * Math.pow(2, attempts), 60_000);
                this._logReconnectAttempts.set(workspacePath, attempts + 1);
                const reconnect = setTimeout(() => {
                    this._logReconnectTimers.delete(workspacePath);
                    if (this._instances.has(workspacePath)) {
                        this._connectLogStream(workspacePath, logPort);
                    }
                }, delay);
                this._logReconnectTimers.set(workspacePath, reconnect);
            }
        });

        this._logSockets.set(workspacePath, sock);
    }

    /** Stop a specific workspace's local linkspan (kills the process). */
    stop(workspacePath: string): void {
        const sock = this._logSockets.get(workspacePath);
        if (sock) {
            sock.destroy();
            this._logSockets.delete(workspacePath);
        }

        const reconnectTimer = this._logReconnectTimers.get(workspacePath);
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            this._logReconnectTimers.delete(workspacePath);
        }
        this._logReconnectAttempts.delete(workspacePath);

        const info = this._instances.get(workspacePath);
        if (info?.pid) {
            try { process.kill(info.pid, 'SIGTERM'); } catch { /* dead */ }
        }

        const proc = this._processes.get(workspacePath);
        if (proc?.pid) {
            try { process.kill(proc.pid, 'SIGTERM'); } catch { /* dead */ }
        }

        this._processes.delete(workspacePath);
        this._instances.delete(workspacePath);
        this._saveState();
    }

    /**
     * Detach from all instances without killing them.
     * Called on VS Code dispose/reload so the linkspan processes keep running.
     */
    detachAll(): void {
        for (const [, sock] of this._logSockets) {
            sock.destroy();
        }
        this._logSockets.clear();

        for (const [, timer] of this._logReconnectTimers) {
            clearTimeout(timer);
        }
        this._logReconnectTimers.clear();
        this._processes.clear();
        // Don't clear _instances or state file — they'll be recovered on next activation
    }

    /** Stop all local linkspan instances (kills processes). */
    stopAll(): void {
        for (const [ws] of this._instances) {
            this.stop(ws);
        }
    }

    /** Get info for a workspace (if running). */
    get(workspacePath: string): LocalLinkspanInfo | undefined {
        return this._instances.get(workspacePath);
    }

    /**
     * Push a metadata value to the local linkspan's store.
     * Uses localhost (not tunnel URL) for reliable local communication.
     */
    private _metadataFailures: Map<string, number> = new Map();

    async setMetadata(workspacePath: string, key: string, value: unknown): Promise<void> {
        const info = this._instances.get(workspacePath);
        if (!info) { return; }
        try {
            process.kill(info.pid, 0);
        } catch {
            return;
        }

        const failKey = `${workspacePath}:${key}`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            await fetch(`http://127.0.0.1:${info.serverPort}/api/v1/metadata/${key}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(value),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (this._metadataFailures.has(failKey)) {
                this._outputChannel.appendLine(`[linkspan-local] Metadata ${key} recovered for ${workspacePath}`);
                this._metadataFailures.delete(failKey);
            }
        } catch (err: any) {
            const count = (this._metadataFailures.get(failKey) || 0) + 1;
            this._metadataFailures.set(failKey, count);
            if (count === 1) {
                this._outputChannel.appendLine(`[linkspan-local] Failed to set metadata ${key}: ${err.message}`);
            }
        }
    }

    // --- Persistence ---

    private _saveState(): void {
        const data = Array.from(this._instances.values());
        try {
            // Atomic write: write to temp file then rename to prevent corruption
            const tmpPath = `${this._stateFilePath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
            fs.renameSync(tmpPath, this._stateFilePath);
        } catch { /* best-effort */ }
    }

    private _loadState(): LocalLinkspanInfo[] {
        try {
            if (!fs.existsSync(this._stateFilePath)) {
                return [];
            }
            const content = fs.readFileSync(this._stateFilePath, 'utf-8');
            return JSON.parse(content);
        } catch {
            return [];
        }
    }
}

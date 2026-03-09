import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { MetricsCollector } from './instrumentation/index.js';

interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
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

export class SshManager {
    private _persistentShells: Map<string, PersistentShell> = new Map();
    private _sshControlDir: string;

    private static readonly SHELL_NOISE_PATTERNS = [
        /system default contains no modules/i,
        /LMOD_SYSTEM_DEFAULT_MODULES/,
        /No changes in loaded modules/i,
        /^\s*$/,
    ];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _outputChannel: vscode.OutputChannel,
        private readonly _metrics: MetricsCollector,
    ) {
        this._sshControlDir = path.join(os.homedir(), '.cs-ssh');
        if (!fs.existsSync(this._sshControlDir)) {
            fs.mkdirSync(this._sshControlDir, { mode: 0o700 });
        }
    }

    static isShellNoise(line: string): boolean {
        return SshManager.SHELL_NOISE_PATTERNS.some(p => p.test(line));
    }

    /**
     * Get SSH args for connection multiplexing (ControlMaster).
     * Uses a short hashed socket name to stay under the 104-byte limit.
     */
    getControlMasterArgs(hostName: string): string[] {
        const hash = crypto.createHash('sha256').update(hostName).digest('hex').substring(0, 16);
        const socketPath = path.join(this._sshControlDir, hash);
        return [
            '-o', `ControlMaster=auto`,
            '-o', `ControlPath=${socketPath}`,
            '-o', `ControlPersist=600`,
        ];
    }

    /**
     * Parse SSH config file and extract host entries.
     */
    getSshHosts(): SshHost[] {
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
                    if (currentHost) {
                        hosts.push(currentHost);
                    }
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
            if (currentHost) {
                hosts.push(currentHost);
            }
        } catch (err) {
            console.error('Error reading SSH config:', err);
        }
        return hosts;
    }

    /**
     * Get or create a persistent SSH shell for a host.
     * The shell stays alive for fast sequential command execution (file browsing).
     */
    _getOrCreateShell(hostName: string): PersistentShell {
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
        let resolveReady!: () => void;
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
                if (readyIdx === -1) {
                    return;
                }
                isReady = true;
                buffer = buffer.slice(readyIdx + readyMarker.length);
                if (buffer.startsWith('\n')) {
                    buffer = buffer.slice(1);
                }
                resolveReady();
                this._metrics.record('ssh_connect', 'success', { target_host: hostName }, Date.now() - shellConnectStart);
            }
            // Process pending command response
            if (shell.pending) {
                const p = shell.pending;
                const exitMarker = `__CS_EXIT_${p.marker}:`;
                const endMarker = `__CS_END_${p.marker}__`;
                while (buffer.length > 0) {
                    if (!p.gotExit) {
                        const exitIdx = buffer.indexOf(exitMarker);
                        if (exitIdx === -1) {
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
                        if (nlIdx === -1) { break; }
                        p.exitCode = parseInt(afterExit.slice(0, nlIdx), 10) || 0;
                        p.gotExit = true;
                        buffer = afterExit.slice(nlIdx + 1);
                    }
                    if (!p.gotEnd) {
                        const endIdx = buffer.indexOf(endMarker);
                        if (endIdx === -1) { break; }
                        p.gotEnd = true;
                        buffer = buffer.slice(endIdx + endMarker.length);
                        if (buffer.startsWith('\n')) {
                            buffer = buffer.slice(1);
                        }
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

        // Handle askpass prompts
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
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { }
            this._persistentShells.delete(hostName);
            if (!isReady) {
                this._metrics.record('ssh_connect', 'failure', { target_host: hostName }, Date.now() - shellConnectStart, 'SSH connection closed before ready');
            }
            if (shell.pending) {
                shell.pending.reject(new Error('SSH connection closed'));
                shell.pending = undefined;
            }
        });

        proc.on('error', (err: Error) => {
            disposed = true;
            clearInterval(pollInterval);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { }
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
    async runShellCommand(hostName: string, command: string): Promise<{ stdout: string; code: number }> {
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
            const wrapped = `${command}\necho "__CS_EXIT_${marker}:$?"\necho "__CS_END_${marker}__"\n`;
            shell.process.stdin!.write(wrapped);
        });
    }

    /**
     * Dispose all persistent SSH shells.
     */
    disposePersistentShells(): void {
        for (const [, shell] of this._persistentShells) {
            shell.process.kill();
        }
        this._persistentShells.clear();
    }

    /**
     * Kill and remove a specific persistent shell.
     */
    killShell(hostName: string): void {
        const shell = this._persistentShells.get(hostName);
        if (shell) {
            shell.process.kill();
            this._persistentShells.delete(hostName);
        }
    }

    /**
     * Run a command on a remote SSH host.
     * Handles SSH_ASKPASS IPC for password/passphrase prompts and ControlMaster multiplexing.
     * Returns a promise that resolves with { stdout, stderr, code }.
     */
    runRemoteCommand(
        hostName: string,
        command: string,
        token?: vscode.CancellationToken,
        stdinData?: string,
    ): Promise<{ stdout: string; stderr: string; code: number }> {
        const cmdStart = Date.now();
        return new Promise((resolve, reject) => {
            const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
            const cancelFile = path.join(sessionDir, 'cancel');
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
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { }
            };

            sshProcess.on('close', (code: number | null) => {
                cleanup();
                const duration = Date.now() - cmdStart;
                if (cancelled) {
                    const err = Object.assign(new Error('Operation cancelled'), { cancelled: true });
                    this._metrics.record('ssh_connect', 'failure', { target_host: hostName }, duration, 'Cancelled');
                    reject(err);
                } else {
                    this._metrics.record(
                        'ssh_connect',
                        (code ?? 1) === 0 ? 'success' : 'failure',
                        { target_host: hostName },
                        duration,
                        code !== 0 ? `exit code ${code}` : undefined,
                    );
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
}

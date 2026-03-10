import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawn } from 'child_process';

interface OutputChannel {
    appendLine(line: string): void;
}

export class DataCache {
    private _mutagenBin?: string;

    /**
     * Progress callback for stage/unstage operations.
     * `transferred` and `total` are in bytes; both may be 0 until rsync
     * calculates the file list.
     */
    onProgress?: (transferred: number, total: number) => void;

    constructor(private readonly _outputChannel: OutputChannel) {}

    /* ------------------------------------------------------------------ */
    /*  Mutagen binary resolution                                         */
    /* ------------------------------------------------------------------ */

    resolveMutagenBin(): string | undefined {
        if (this._mutagenBin) {
            return this._mutagenBin;
        }
        const candidates = [
            path.join(os.homedir(), '.cybershuttle', 'bin', 'mutagen'),
            '/opt/homebrew/bin/mutagen',
            '/usr/local/bin/mutagen',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                this._mutagenBin = p;
                return p;
            }
        }
        return undefined;
    }

    async ensureMutagen(): Promise<string> {
        const existing = this.resolveMutagenBin();
        if (existing) {
            return existing;
        }
        const binDir = path.join(os.homedir(), '.cybershuttle', 'bin');
        const binPath = path.join(binDir, 'mutagen');
        const platformMap: Record<string, string> = { darwin: 'darwin', linux: 'linux' };
        const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
        const osName = platformMap[process.platform];
        const archName = archMap[process.arch];
        if (!osName || !archName) {
            throw new Error(`Unsupported platform for mutagen: ${process.platform}/${process.arch}`);
        }
        this._outputChannel.appendLine('[mutagen] Fetching latest release version...');
        const versionOutput = execSync(
            `curl -fsSL "https://api.github.com/repos/mutagen-io/mutagen/releases/latest" | grep '"tag_name"' | head -1`,
            { encoding: 'utf-8', timeout: 15_000 },
        );
        const versionMatch = versionOutput.match(/"tag_name"\s*:\s*"(v[\d.]+)"/);
        if (!versionMatch) {
            throw new Error('Failed to determine latest mutagen version');
        }
        const version = versionMatch[1];
        const assetName = `mutagen_${osName}_${archName}_${version}.tar.gz`;
        const downloadUrl = `https://github.com/mutagen-io/mutagen/releases/latest/download/${assetName}`;
        this._outputChannel.appendLine(`[mutagen] Downloading ${version} from ${downloadUrl}`);
        fs.mkdirSync(binDir, { recursive: true });
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('bash', [
                '-c',
                `curl -fsSL "${downloadUrl}" | tar -xz -C "${binDir}" mutagen mutagen-agents.tar.gz && chmod +x "${binPath}"`,
            ], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
            proc.on('close', (code: number | null) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to download mutagen: ${stderr}`));
                }
            });
            proc.on('error', reject);
        });
        this._outputChannel.appendLine(`[mutagen] Downloaded to ${binPath}`);
        this._mutagenBin = binPath;
        return binPath;
    }

    /* ------------------------------------------------------------------ */
    /*  Data staging (rsync)                                              */
    /* ------------------------------------------------------------------ */

    async stage(
        localDir: string,
        host: string,
        sessionId: string,
        runRemoteCommand: (host: string, cmd: string) => Promise<unknown>,
    ): Promise<void> {
        const remoteDir = `~/sessions/${sessionId}/`;
        this._outputChannel.appendLine(`[sync] Pre-syncing to ${host}:${remoteDir}`);
        await runRemoteCommand(host, `mkdir -p ${remoteDir}`);
        await this._runRsync([
            '-az', '--delete',
            '-e', 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
            `${localDir}/`, `${host}:${remoteDir}`,
        ]);
        this._outputChannel.appendLine(`[sync] Pre-sync complete`);
    }

    async unstage(
        localDir: string,
        host: string,
        sessionId: string,
        runRemoteCommand: (host: string, cmd: string) => Promise<unknown>,
    ): Promise<void> {
        const remoteDir = `~/sessions/${sessionId}/`;
        this._outputChannel.appendLine(`[sync] Syncing back from ${host}:${remoteDir}`);
        // No --delete: we must never remove local files that weren't in the
        // remote session directory (the remote is a subset of the workspace).
        await this._runRsync([
            '-az',
            '-e', 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
            `${host}:${remoteDir}`, `${localDir}/`,
        ]);
        this._outputChannel.appendLine(`[sync] Sync-back complete`);
        try {
            await runRemoteCommand(host, `rm -rf ~/sessions/${sessionId}`);
        } catch { /* best-effort */ }
    }

    /* ------------------------------------------------------------------ */
    /*  Continuous sync (mutagen)                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Start a continuous mutagen sync session between localDir and the remote
     * session directory. Uses the login node SSH (shared FS) — not the devtunnel.
     */
    async startContinuousSync(localDir: string, host: string, sessionId: string): Promise<string> {
        const mutagenBin = await this.ensureMutagen();
        const sessionName = `cs-sync-${sessionId}`;
        const remoteDir = `~/sessions/${sessionId}`;
        const args = [
            'sync', 'create',
            '--name', sessionName,
            '--label', 'cs-bridge=true',
            '--sync-mode', 'two-way-safe',
            '--ignore-vcs',
            '--ssh-flags=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
            localDir,
            `${host}:${remoteDir}`,
        ];
        this._outputChannel.appendLine(`[mutagen] Starting continuous sync: ${sessionName}`);
        execSync(`"${mutagenBin}" ${args.map(a => JSON.stringify(a)).join(' ')}`, {
            timeout: 30_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this._outputChannel.appendLine(`[mutagen] Continuous sync started: ${sessionName}`);
        return sessionName;
    }

    /**
     * Flush and terminate a continuous mutagen sync session.
     */
    async stopContinuousSync(sessionId: string): Promise<void> {
        const bin = this.resolveMutagenBin();
        if (!bin) {
            return;
        }
        const sessionName = `cs-sync-${sessionId}`;
        this._outputChannel.appendLine(`[mutagen] Stopping continuous sync: ${sessionName}`);
        try {
            execSync(`"${bin}" sync flush "${sessionName}" 2>/dev/null`, { timeout: 30_000 });
        } catch { /* session may already be gone */ }
        try {
            execSync(`"${bin}" sync terminate "${sessionName}" 2>/dev/null`, { timeout: 5_000 });
            this._outputChannel.appendLine(`[mutagen] Terminated continuous sync: ${sessionName}`);
        } catch { /* already gone */ }
    }

    /**
     * Run rsync with optional --info=progress2 for progress reporting.
     * Falls back to running without progress flags if rsync is too old.
     */
    private async _runRsync(args: string[]): Promise<void> {
        try {
            await this._runRsyncImpl(['--info=progress2', '--no-inc-recursive', ...args], true);
        } catch (err: unknown) {
            if (err instanceof Error && err.message?.includes('unrecognized option')) {
                this._outputChannel.appendLine('[sync] rsync too old for --info=progress2, retrying without');
                await this._runRsyncImpl(args, false);
            } else {
                throw err;
            }
        }
    }

    private _runRsyncImpl(args: string[], parseProgress: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn('rsync', args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
            if (parseProgress) {
                // --info=progress2 outputs lines like:
                //   1,234,567  45%  12.34MB/s  0:00:03
                proc.stdout!.on('data', (d: Buffer) => {
                    if (!this.onProgress) {
                        return;
                    }
                    const line = d.toString();
                    const m = line.match(/([\d,]+)\s+(\d+)%/);
                    if (m) {
                        const transferred = parseInt(m[1].replace(/,/g, ''), 10);
                        const pct = parseInt(m[2], 10);
                        const total = pct > 0 ? Math.round(transferred / (pct / 100)) : 0;
                        this.onProgress(transferred, total);
                    }
                });
            }
            proc.on('close', (code: number | null) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`rsync exited with code ${code}: ${stderr}`));
                }
            });
            proc.on('error', reject);
            // 2-minute timeout
            setTimeout(() => {
                proc.kill();
                reject(new Error('rsync timed out after 120s'));
            }, 120_000);
        });
    }

    async cleanup(
        host: string,
        sessionId: string,
        runRemoteCommand: (host: string, cmd: string) => Promise<unknown>,
    ): Promise<void> {
        await runRemoteCommand(host, `rm -rf ~/sessions/${sessionId}`);
    }
}

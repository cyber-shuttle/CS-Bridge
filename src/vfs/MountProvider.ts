import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { DataCache } from './DataCache.js';

interface MountSession {
    id: string;
    mutagenSessionName?: string;
    sshfsPid?: number;
    sshfsMountPath?: string;
}

interface OutputChannel {
    appendLine(line: string): void;
}

export class MountProvider {
    private _dataCache: DataCache;
    private _outputChannel: OutputChannel;
    private _sshfsBin?: string;

    constructor(_dataCache: DataCache, _outputChannel: OutputChannel) {
        this._dataCache = _dataCache;
        this._outputChannel = _outputChannel;
    }

    /* ------------------------------------------------------------------ */
    /*  sshfs binary resolution                                           */
    /* ------------------------------------------------------------------ */

    private _resolveSshfsBin(): string | undefined {
        if (this._sshfsBin) {
            return this._sshfsBin;
        }
        const candidates = [
            path.join(os.homedir(), '.cybershuttle', 'bin', 'sshfs'),
            '/opt/homebrew/bin/sshfs',
            '/usr/local/bin/sshfs',
            '/usr/bin/sshfs',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                this._sshfsBin = p;
                return p;
            }
        }
        // Fall back to `which sshfs`
        try {
            const result = execSync('which sshfs', { encoding: 'utf-8', timeout: 5_000 }).trim();
            if (result && fs.existsSync(result)) {
                this._sshfsBin = result;
                return result;
            }
        } catch { /* not found */ }
        return undefined;
    }

    ensureSshfs(): string {
        const bin = this._resolveSshfsBin();
        if (bin) {
            return bin;
        }
        if (process.platform === 'darwin') {
            throw new Error(
                'sshfs not found. Install it via Homebrew:\n' +
                '  brew install macfuse\n' +
                '  brew install gromgit/fuse/sshfs-mac',
            );
        } else {
            throw new Error(
                'sshfs not found. Install it via your package manager:\n' +
                '  sudo apt-get install sshfs',
            );
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Mount point helpers                                               */
    /* ------------------------------------------------------------------ */

    mountPoint(sessionId: string): string {
        return path.join(os.homedir(), '.cybershuttle', 'mounts', `cs-mount-${sessionId}`);
    }

    /* ------------------------------------------------------------------ */
    /*  Start: sshfs mount + mutagen cache-warmer                         */
    /* ------------------------------------------------------------------ */

    async start(session: MountSession, hostAlias: string): Promise<void> {
        const sshfsBin = this.ensureSshfs();
        const mountDir = this.mountPoint(session.id);
        fs.mkdirSync(mountDir, { recursive: true });
        const remoteDir = `~/sessions/${session.id}`;
        const sshfsArgs = [
            `${hostAlias}:${remoteDir}`,
            mountDir,
            '-o', 'reconnect',
            '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=3',
            '-o', 'dir_cache=yes',
            '-o', 'dcache_timeout=30',
            '-o', 'auto_cache',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-f', // foreground so we can track the PID
        ];
        const tryMount = async (): Promise<boolean> => {
            const proc = spawn(sshfsBin, sshfsArgs, {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.unref();
            session.sshfsPid = proc.pid;
            session.sshfsMountPath = mountDir;
            this._outputChannel.appendLine(
                `[sshfs] Spawned sshfs (pid=${proc.pid}) mounting ${hostAlias}:${remoteDir} -> ${mountDir}`,
            );
            // Wait for the mount to appear
            await new Promise(resolve => setTimeout(resolve, 2_000));
            // Verify mount
            try {
                const mountOutput = execSync('mount', { encoding: 'utf-8', timeout: 5_000 });
                if (mountOutput.includes(mountDir)) {
                    this._outputChannel.appendLine(`[sshfs] Mount verified at ${mountDir}`);
                    return true;
                }
            } catch { /* ignore */ }
            this._outputChannel.appendLine(`[sshfs] Mount not detected at ${mountDir}, will retry...`);
            // Kill the failed process
            if (proc.pid) {
                try {
                    process.kill(proc.pid, 'SIGTERM');
                } catch { /* ok */ }
            }
            return false;
        };
        // First attempt
        let mounted = await tryMount();
        if (!mounted) {
            // Retry once
            this._outputChannel.appendLine(`[sshfs] Retrying mount...`);
            mounted = await tryMount();
            if (!mounted) {
                // Clean up
                session.sshfsPid = undefined;
                session.sshfsMountPath = undefined;
                try {
                    fs.rmdirSync(mountDir);
                } catch { /* ok */ }
                throw new Error(`Failed to mount ${hostAlias}:${remoteDir} at ${mountDir} after 2 attempts`);
            }
        }
        // Start mutagen cache-warmer
        try {
            const mutagenBin = await this._dataCache.ensureMutagen();
            const sessionName = `cs-cache-${session.id}`;
            const mutagenCmd = [
                `"${mutagenBin}"`, 'sync', 'create',
                mountDir,
                `${hostAlias}:${remoteDir}`,
                `--name=${sessionName}`,
                '--label=cs-bridge=true',
                '--sync-mode=two-way-safe',
                '--ignore-vcs',
            ].join(' ');
            this._outputChannel.appendLine(`[mutagen] Starting cache-warmer: ${sessionName}`);
            execSync(mutagenCmd, { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
            session.mutagenSessionName = sessionName;
            this._outputChannel.appendLine(`[mutagen] Cache-warmer started: ${sessionName}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`[mutagen] Warning: Failed to start cache-warmer: ${msg}`);
            // Non-fatal — the sshfs mount is still usable without the cache-warmer
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Stop: tear down mutagen + sshfs                                   */
    /* ------------------------------------------------------------------ */

    async stop(session: MountSession): Promise<void> {
        // 1. Stop mutagen cache-warmer
        if (session.mutagenSessionName) {
            const mutagenBin = this._dataCache.resolveMutagenBin();
            if (mutagenBin) {
                try {
                    execSync(`"${mutagenBin}" sync flush ${session.mutagenSessionName} 2>/dev/null`, { timeout: 30_000 });
                } catch { /* best-effort flush */ }
                try {
                    execSync(`"${mutagenBin}" sync terminate ${session.mutagenSessionName} 2>/dev/null`, { timeout: 5_000 });
                    this._outputChannel.appendLine(`[mutagen] Terminated cache-warmer: ${session.mutagenSessionName}`);
                } catch { /* ok */ }
            }
            session.mutagenSessionName = undefined;
        }
        // 2. Unmount sshfs — unmount FIRST so the foreground sshfs process exits cleanly
        const mountDir = session.sshfsMountPath;
        if (mountDir) {
            this._unmountAndCleanup(mountDir);
            // Kill sshfs process as a fallback (in case unmount didn't cause it to exit)
            if (session.sshfsPid) {
                try {
                    process.kill(session.sshfsPid, 'SIGTERM');
                } catch { /* already dead */ }
                // Wait 2s for graceful exit, then SIGKILL
                await new Promise(resolve => setTimeout(resolve, 2_000));
                try {
                    process.kill(session.sshfsPid, 'SIGKILL');
                } catch { /* already dead */ }
                session.sshfsPid = undefined;
            }
            session.sshfsMountPath = undefined;
        }
    }

    /**
     * Synchronous cleanup for use in dispose() — no flush, just kill + unmount.
     */
    stopSync(session: MountSession): void {
        // Terminate mutagen cache-warmer
        if (session.mutagenSessionName) {
            const bin = this._dataCache.resolveMutagenBin();
            if (bin) {
                try {
                    execSync(`"${bin}" sync terminate ${session.mutagenSessionName} 2>/dev/null`, { timeout: 5_000 });
                } catch { }
            }
            session.mutagenSessionName = undefined;
        }
        // Unmount first, then kill sshfs process as fallback
        if (session.sshfsMountPath) {
            this._unmountAndCleanup(session.sshfsMountPath);
            if (session.sshfsPid) {
                try {
                    process.kill(session.sshfsPid, 'SIGKILL');
                } catch { }
                session.sshfsPid = undefined;
            }
            session.sshfsMountPath = undefined;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Unmount + cleanup helper                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Unmount a FUSE mount point and remove its directory.
     * Tries a graceful unmount first, then a force unmount on failure.
     */
    private _unmountAndCleanup(mountDir: string): void {
        // Graceful unmount
        try {
            if (process.platform === 'darwin') {
                execSync(`umount "${mountDir}" 2>/dev/null`, { timeout: 10_000 });
            } else {
                execSync(`fusermount -u "${mountDir}" 2>/dev/null`, { timeout: 10_000 });
            }
            this._outputChannel.appendLine(`[sshfs] Unmounted ${mountDir}`);
        } catch {
            // Graceful unmount failed — try force unmount
            this._outputChannel.appendLine(`[sshfs] Graceful unmount failed for ${mountDir}, trying force unmount`);
            try {
                if (process.platform === 'darwin') {
                    execSync(`diskutil unmount force "${mountDir}" 2>/dev/null`, { timeout: 10_000 });
                } else {
                    execSync(`fusermount -uz "${mountDir}" 2>/dev/null`, { timeout: 10_000 });
                }
                this._outputChannel.appendLine(`[sshfs] Force-unmounted ${mountDir}`);
            } catch {
                this._outputChannel.appendLine(`[sshfs] Warning: Could not unmount ${mountDir}`);
            }
        }
        // Remove mount directory
        try {
            fs.rmdirSync(mountDir);
        } catch { /* ok — may still be in use */ }
    }

    /* ------------------------------------------------------------------ */
    /*  Clean stale mounts                                                */
    /* ------------------------------------------------------------------ */

    cleanStaleMounts(): void {
        const mountsDir = path.join(os.homedir(), '.cybershuttle', 'mounts');
        if (!fs.existsSync(mountsDir)) {
            return;
        }
        let entries: string[];
        try {
            entries = fs.readdirSync(mountsDir);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.startsWith('cs-mount-')) {
                continue;
            }
            const fullPath = path.join(mountsDir, entry);
            this._outputChannel.appendLine(`[sshfs] Cleaning stale mount: ${fullPath}`);
            this._unmountAndCleanup(fullPath);
        }
    }
}

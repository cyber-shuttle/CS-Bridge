import { execSync } from 'child_process';
import { DataCache } from './DataCache.js';

interface SyncSession {
    id: string;
    localWorkdir?: string;
    mutagenSessionName?: string;
}

interface OutputChannel {
    appendLine(line: string): void;
}

export class SyncProvider {
    private _dataCache: DataCache;
    private _outputChannel: OutputChannel;

    constructor(dataCache: DataCache, outputChannel: OutputChannel) {
        this._dataCache = dataCache;
        this._outputChannel = outputChannel;
    }

    /**
     * Create a mutagen two-way-safe sync session between the local workdir
     * and the remote ~/sessions/<id> directory.
     */
    async start(session: SyncSession, hostAlias: string): Promise<void> {
        if (!session.localWorkdir) {
            return;
        }
        const mutagenBin = await this._dataCache.ensureMutagen();
        const sessionName = `cs-sync-${session.id}`;
        const remoteDir = `~/sessions/${session.id}`;
        // Best-effort: create remote directory
        try {
            execSync(
                `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${hostAlias} sh -c ${JSON.stringify(`mkdir -p ${remoteDir}`)}`,
                { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
            );
        } catch { /* best-effort */ }
        const mutagenCmd = [
            `"${mutagenBin}"`, 'sync', 'create',
            '--name', sessionName,
            '--label', 'cs-bridge=true',
            '--sync-mode', 'two-way-safe',
            '--ignore-vcs',
            `--ssh-flags=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`,
            `"${session.localWorkdir}"`,
            `${hostAlias}:${remoteDir}`,
        ].join(' ');
        this._outputChannel.appendLine(`[mutagen] Starting sync: ${sessionName}`);
        execSync(mutagenCmd, { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
        session.mutagenSessionName = sessionName;
        this._outputChannel.appendLine(`[mutagen] Sync session started: ${sessionName}`);
    }

    /**
     * Flush and terminate a mutagen sync session.
     */
    async stop(session: SyncSession): Promise<void> {
        if (!session.mutagenSessionName) {
            return;
        }
        const bin = this._dataCache.resolveMutagenBin();
        if (!bin) {
            session.mutagenSessionName = undefined;
            return;
        }
        try {
            execSync(`"${bin}" sync flush ${session.mutagenSessionName} 2>/dev/null`, { timeout: 30_000 });
        } catch { /* ok -- session may already be terminated */ }
        try {
            execSync(`"${bin}" sync terminate ${session.mutagenSessionName} 2>/dev/null`, { timeout: 5_000 });
            this._outputChannel.appendLine(`[mutagen] Terminated sync session: ${session.mutagenSessionName}`);
        } catch { /* already gone */ }
        session.mutagenSessionName = undefined;
    }

    /**
     * Synchronous cleanup for use in dispose() — no flush, just terminate.
     */
    stopSync(session: SyncSession): void {
        if (!session.mutagenSessionName) {
            return;
        }
        const bin = this._dataCache.resolveMutagenBin();
        if (bin) {
            try {
                execSync(`"${bin}" sync terminate ${session.mutagenSessionName} 2>/dev/null`, { timeout: 5_000 });
            } catch { }
        }
        session.mutagenSessionName = undefined;
    }

    /**
     * Terminate all orphaned cs-bridge mutagen sessions on startup.
     */
    cleanStaleSessions(): void {
        const bin = this._dataCache.resolveMutagenBin();
        if (!bin) {
            return;
        }
        try {
            const result = execSync(`"${bin}" sync list --label-selector=cs-bridge=true 2>/dev/null`, {
                encoding: 'utf-8', timeout: 10_000,
            });
            const nameRe = /Name:\s+(cs-sync-\S+)/g;
            let m: RegExpExecArray | null;
            while ((m = nameRe.exec(result)) !== null) {
                const name = m[1];
                try {
                    execSync(`"${bin}" sync terminate ${name} 2>/dev/null`, { timeout: 5_000 });
                    this._outputChannel.appendLine(`[startup] Terminated stale mutagen session: ${name}`);
                } catch { /* already gone */ }
            }
        } catch { /* no sessions */ }
    }
}

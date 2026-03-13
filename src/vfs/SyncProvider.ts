import { spawnSync } from 'child_process';
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
        // Best-effort: create remote directory (spawnSync avoids shell quoting issues)
        try {
            spawnSync('ssh', [
                '-o', 'ConnectTimeout=5',
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'UserKnownHostsFile=/dev/null',
                hostAlias,
                `mkdir -p ${remoteDir}`,
            ], { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch { /* best-effort */ }
        const mutagenArgs = [
            'sync', 'create',
            '--name', sessionName,
            '--label', 'cs-bridge=true',
            '--sync-mode', 'two-way-safe',
            '--ignore-vcs',
            '--ssh-flags=-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
            session.localWorkdir!,
            `${hostAlias}:${remoteDir}`,
        ];
        this._outputChannel.appendLine(`[mutagen] Starting sync: ${sessionName}`);
        const mutagenResult = spawnSync(mutagenBin, mutagenArgs, { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
        if (mutagenResult.status !== 0) {
            throw new Error(`mutagen sync create failed: ${mutagenResult.stderr?.toString() || 'unknown error'}`);
        }
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
            spawnSync(bin, ['sync', 'flush', session.mutagenSessionName], { timeout: 30_000, stdio: 'pipe' });
        } catch { /* ok -- session may already be terminated */ }
        try {
            spawnSync(bin, ['sync', 'terminate', session.mutagenSessionName], { timeout: 5_000, stdio: 'pipe' });
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
                spawnSync(bin, ['sync', 'terminate', session.mutagenSessionName], { timeout: 5_000, stdio: 'pipe' });
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
            const listResult = spawnSync(bin, ['sync', 'list', '--label-selector=cs-bridge=true'], {
                encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
            });
            const result = listResult.stdout || '';
            const nameRe = /Name:\s+(cs-sync-\S+)/g;
            let m: RegExpExecArray | null;
            while ((m = nameRe.exec(result)) !== null) {
                const name = m[1];
                try {
                    spawnSync(bin, ['sync', 'terminate', name], { timeout: 5_000, stdio: 'pipe' });
                    this._outputChannel.appendLine(`[startup] Terminated stale mutagen session: ${name}`);
                } catch { /* already gone */ }
            }
        } catch { /* no sessions */ }
    }
}

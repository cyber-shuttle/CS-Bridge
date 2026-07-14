import * as fs from 'fs';

export function isPidAlive(pid: number | undefined): boolean {
    if (pid === undefined) { return false; }
    // signal 0 is the POSIX null-signal probe - doesn't actually send anything; throws ESRCH if pid is gone.
    try { process.kill(pid, 0); return true; }
    catch { return false; }
}

// Cross-process mutex on `${filepath}.lock`. Stale locks (owner pid dead) are reclaimed.
export function lock(filepath: string): void {
    const lockPath = `${filepath}.lock`;
    const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
        try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            return;
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
            let owner = NaN;
            try { owner = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10); }
            catch { /* lock vanished */ }
            if (Number.isFinite(owner) && !isPidAlive(owner)) {
                try { fs.unlinkSync(lockPath); }
                catch { /* someone else cleaned it */ }
                continue;
            }
            Atomics.wait(sleepBuffer, 0, 0, 10);
        }
    }
}

export function release(filepath: string): void {
    try { fs.unlinkSync(`${filepath}.lock`); }
    catch { /* already gone */ }
}

// JSON-array file read with a graceful fallback: missing file (ENOENT on first run), unparseable, or a corrupt /
// hand-edited non-array all yield []. Shared by the sessions.json and runs.json stores.
export function readJsonArray<T>(file: string): T[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch { return []; }
}

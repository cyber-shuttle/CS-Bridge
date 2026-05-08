import * as fs from 'fs';

export function isPidAlive(pid: number | undefined): boolean {
    if (pid === undefined) { return false; }
    // signal 0 is the POSIX null-signal probe - doesn't actually send anything; throws ESRCH if pid is gone.
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// Cross-process mutex on `${filepath}.lock`. Stale locks (owner pid dead) are reclaimed.
export function lock(filepath: string): void {
    const lockPath = `${filepath}.lock`;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
        try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            return;
        } catch (err: any) {
            if (err.code !== 'EEXIST') { throw err; }
            let content = '';
            try { content = fs.readFileSync(lockPath, 'utf-8').trim(); } catch { /* lock vanished */ }
            const owner = parseInt(content, 10);
            if (content && Number.isFinite(owner) && !isPidAlive(owner)) {
                try { fs.unlinkSync(lockPath); } catch { /* someone else cleaned it */ }
                continue;
            }
            Atomics.wait(sleeper, 0, 0, 10);
        }
    }
}

export function release(filepath: string): void {
    try { fs.unlinkSync(`${filepath}.lock`); } catch { /* already gone */ }
}

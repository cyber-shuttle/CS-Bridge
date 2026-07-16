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

// JSON-array file read; missing, unparseable, or non-array all yield []. Shared by the sessions.json / runs.json stores.
export function readJsonArray<T>(file: string): T[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch { return []; }
}

// Locked read-modify-write of a JSON-array file. `mutate` returns the array to write, or null to skip (no-op). The
// write is atomic (temp + rename) so a crash mid-write can't corrupt the file, and unlocked readers in other windows
// see the old or new file whole, never a truncated one.
export function updateJsonArray<T>(file: string, mutate: (arr: T[]) => T[] | null, onError?: (err: unknown) => void): void {
    lock(file);
    try {
        const next = mutate(readJsonArray<T>(file));
        if (next !== null) {
            fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf-8');
            fs.renameSync(`${file}.tmp`, file);
        }
    }
    catch (err) { onError?.(err); }
    finally { release(file); }
}

// fs.watch a directory for one file's changes. Lenient match: a temp+rename write can surface as the filename or (on
// some platforms) a null filename, so fire on either.
export function watchDirFile(dir: string, filename: string, callback: () => void): fs.FSWatcher {
    return fs.watch(dir, (_, changed) => { if (!changed || changed === filename) { callback(); } });
}

// Single-object JSON read; atomic writers make torn reads impossible, so this is lock-free. Missing/unparseable → undefined.
export function readJson<T>(file: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; }
    catch { return undefined; }
}

// Per-file locked read-modify-write (atomic temp+rename). `mutate` returns the value to write, or null to skip.
export function updateJson<T>(file: string, mutate: (cur: T | undefined) => T | null, onError?: (err: unknown) => void): void {
    lock(file);
    try {
        const next = mutate(readJson<T>(file));
        if (next !== null) {
            fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf-8');
            fs.renameSync(`${file}.tmp`, file);
        }
    }
    catch (err) { onError?.(err); }
    finally { release(file); }
}

export function deleteFile(file: string): void {
    try { fs.unlinkSync(file); }
    catch { /* already gone */ }
}

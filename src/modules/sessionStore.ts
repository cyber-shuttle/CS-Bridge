import { SlurmSession, persistableConnectionInfo } from '../models';

// Upsert one on-disk record into mem in place (identity kept, in-memory connectionInfo preserved). Returns if it changed.
function upsertRecord(mem: SlurmSession[], d: SlurmSession): boolean {
    const m = mem.find(s => s.id === d.id);
    if (!m) { mem.push(d); return true; }
    const before = JSON.stringify(m);
    Object.assign(m, d, { connectionInfo: m.connectionInfo ?? d.connectionInfo });
    return JSON.stringify(m) !== before;
}

// Merge a single changed record into mem in place (undefined = its file was deleted). Returns whether anything changed.
// The hot path: a window's watcher fires on every record write, so it reads only the one file that changed.
export function mergeRecord(mem: SlurmSession[], id: string, disk: SlurmSession | undefined): boolean {
    if (disk) { return upsertRecord(mem, disk); }
    const i = mem.findIndex(s => s.id === id);
    if (i === -1) { return false; }
    mem.splice(i, 1);
    return true;
}

// Reconcile in-memory sessions to the full disk set in place (never swap identity, so monitor/connect refs stay valid).
// Used only for the initial load and the rare platform that doesn't report which file changed. Returns whether anything changed.
export function mergeFromDisk(mem: SlurmSession[], disk: SlurmSession[]): boolean {
    let changed = false;
    for (const d of disk) { if (upsertRecord(mem, d)) { changed = true; } }
    const diskIds = new Set(disk.map(s => s.id));
    for (let i = mem.length - 1; i >= 0; i--) {
        if (!diskIds.has(mem[i].id)) { mem.splice(i, 1); changed = true; }
    }
    return changed;
}

// Persisted record: secrets trimmed, windowPids kept from disk so a write can't clobber another window's pids.
export function toPersistedRecord(session: SlurmSession, diskWindowPids?: number[]): SlurmSession {
    return { ...session, connectionInfo: persistableConnectionInfo(session.connectionInfo), windowPids: diskWindowPids ?? session.windowPids };
}

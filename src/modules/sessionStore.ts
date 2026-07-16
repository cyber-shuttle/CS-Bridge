import { SlurmSession, persistableConnectionInfo } from '../models';

// Reconcile in-memory sessions to disk IN PLACE (refresh existing instances so monitor/connect refs stay valid, add
// new ids, drop removed). Keeps this window's in-memory connectionInfo. Returns whether anything changed.
export function mergeFromDisk(mem: SlurmSession[], disk: SlurmSession[]): boolean {
    let changed = false;
    const diskIds = new Set(disk.map(s => s.id));
    for (const d of disk) {
        const m = mem.find(s => s.id === d.id);
        if (!m) { mem.push(d); changed = true; continue; }
        const before = JSON.stringify(m);
        Object.assign(m, d, { connectionInfo: m.connectionInfo ?? d.connectionInfo });
        if (JSON.stringify(m) !== before) { changed = true; }
    }
    for (let i = mem.length - 1; i >= 0; i--) {
        if (!diskIds.has(mem[i].id)) { mem.splice(i, 1); changed = true; }
    }
    return changed;
}

// This session's persisted record: secrets trimmed, windowPids kept from disk (owned by mutateWindowPids) so a record
// write never clobbers another window's pids.
export function toPersistedRecord(session: SlurmSession, diskWindowPids?: number[]): SlurmSession {
    return { ...session, connectionInfo: persistableConnectionInfo(session.connectionInfo), windowPids: diskWindowPids ?? session.windowPids };
}

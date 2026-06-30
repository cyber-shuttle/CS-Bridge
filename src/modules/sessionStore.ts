import { SlurmSession, persistableConnectionInfo } from '../models';

// Reconcile the in-memory list to the on-disk records IN PLACE: refresh existing instances (so references held by
// the monitor / in-flight connect stay valid and never go stale), append new ids, drop removed ones. Keeps this
// window's in-memory connectionInfo (secrets + live forward port), which is never persisted to disk.
export function mergeFromDisk(mem: SlurmSession[], disk: SlurmSession[]): void {
    const diskIds = new Set(disk.map(s => s.id));
    for (const d of disk) {
        const m = mem.find(s => s.id === d.id);
        if (m) { Object.assign(m, d, { connectionInfo: m.connectionInfo ?? d.connectionInfo }); }
        else { mem.push(d); }
    }
    for (let i = mem.length - 1; i >= 0; i--) {
        if (!diskIds.has(mem[i].id)) { mem.splice(i, 1); }
    }
}

// Replace ONLY this session's on-disk record (secrets stripped, windowPids left to mutateWindowPids), so a write
// for one session can never clobber a sibling another window changed concurrently.
export function upsertRecord(disk: SlurmSession[], session: SlurmSession): void {
    const persisted = { ...session, connectionInfo: persistableConnectionInfo(session.connectionInfo) };
    const i = disk.findIndex(s => s.id === session.id);
    if (i >= 0) { persisted.windowPids = disk[i].windowPids; disk[i] = persisted; }
    else { disk.push(persisted); }
}

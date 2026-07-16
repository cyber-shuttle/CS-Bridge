import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uuidv7 } from 'uuidv7';
import { Logger } from './logger';
import { readJson, updateJson, deleteFile, isPidAlive } from './modules/fsSupport';
import { SlurmSession } from './models';
import { mergeFromDisk, toPersistedRecord } from './modules/sessionStore';

export const CS_HOME = path.join(os.homedir(), '.cybershuttle');

const logger = Logger.getInstance();
// One record file per session (sessions/{id}.json), so each session locks independently — no shared sessions.json lock
// whose contention compounds with sessions × windows.
let sessions: SlurmSession[] = [];
let sessionsDir = '';

const isUuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const recordPath = (id: string): string => path.join(sessionsDir, `${id}.json`);
const isRecordFile = (name: string): boolean => name.endsWith('.json'); // excludes the *.json.tmp mid-write temp

function readAllRecords(): SlurmSession[] {
    try {
        return fs.readdirSync(sessionsDir).filter(isRecordFile)
            .map(n => readJson<SlurmSession>(path.join(sessionsDir, n)))
            .filter((s): s is SlurmSession => !!s);
    }
    catch { return []; }
}

// Preserves the on-disk windowPids (owned by mutateWindowPids) so a record write can't clobber another window's pids.
function writeRecord(session: SlurmSession): void {
    updateJson<SlurmSession>(recordPath(session.id), cur => toPersistedRecord(session, cur?.windowPids),
        err => logger.error(`Failed to save session ${session.id}`, err));
}

// One-time: split a legacy sessions.json array into per-session record files, then retire it.
function migrateLegacyFile(): void {
    const legacy = path.join(CS_HOME, 'sessions.json');
    let arr: unknown;
    try { arr = JSON.parse(fs.readFileSync(legacy, 'utf-8')); }
    catch { return; }
    if (Array.isArray(arr)) { for (const s of arr as SlurmSession[]) { writeRecord(s); } }
    deleteFile(legacy);
}

export function initSessionStore(storagePath: string = CS_HOME): string {
    sessionsDir = path.join(storagePath, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    migrateLegacyFile();
    sessions = readAllRecords();
    for (const s of sessions) {
        // The relay is gone after a reload; demote so the UI offers Connect (which reattaches from the persisted refs).
        if (s.status === 'connected' || s.status === 'connecting') { s.status = 'ready_to_connect'; }
        // A prompt that outlived its window can't be answered anymore; surface it as interrupted (offers Retry).
        if (s.status === 'awaiting_input') { s.status = 'interrupted'; }
        if (!isUuid(s.id)) { deleteFile(recordPath(s.id)); s.id = uuidv7(); writeRecord(s); }
    }
    logger.info(`Loaded ${sessions.length} session(s) from ${sessionsDir}`);
    return sessionsDir;
}

export function getAllSessions(): SlurmSession[] {
    return sessions;
}

export function getSession(sessionId: string): SlurmSession | undefined {
    return sessions.find(s => s.id === sessionId);
}

export function addSession(session: SlurmSession) {
    sessions.push(session);
    writeRecord(session);
}

export function updateSession(session: SlurmSession) {
    const index = sessions.findIndex(s => s.id === session.id);
    if (index === -1) { return; }
    sessions[index] = session;
    writeRecord(session);
}

export function removeSession(sessionId: string) {
    const index = sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) { sessions.splice(index, 1); }
    deleteFile(recordPath(sessionId));
}

export function mutateWindowPids(sessionId: string, transform: (pids: number[]) => number[]): void {
    updateJson<SlurmSession>(recordPath(sessionId), (cur) => {
        if (!cur) { return null; }
        cur.windowPids = transform(cur.windowPids ?? []);
        const mem = sessions.find(s => s.id === sessionId);
        if (mem) { mem.windowPids = cur.windowPids; }
        return cur;
    }, err => logger.error(`Failed to update windowPids for ${sessionId}`, err));
}

export function liveAndCleanup(s: SlurmSession): { isCurrent: boolean; windowAlive: boolean } {
    const pids = s.windowPids ?? [];
    const live = pids.filter(isPidAlive);
    if (live.length !== pids.length) { mutateWindowPids(s.id, () => live); }
    return { isCurrent: live.includes(process.pid), windowAlive: live.length > 0 };
}

// Cross-window sync: reconcile in-memory from the per-session files in place (never swap identity, so monitor/connect
// refs stay valid). Lock-free reads (atomic writes → whole files); fires only when the record set actually changed.
export function watchSessions(callback: () => void): fs.FSWatcher {
    return fs.watch(sessionsDir, (_event, filename) => {
        if (filename && !isRecordFile(filename)) { return; }
        if (mergeFromDisk(sessions, readAllRecords())) { callback(); }
    });
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uuidv7 } from 'uuidv7';
import { Logger } from './logger';
import { readJson, updateJson, deleteFile, isPidAlive } from './modules/fsSupport';
import { SlurmSession } from './models';
import { mergeFromDisk, toPersistedRecord } from './modules/sessionStore';
import { deleteSessionMetrics } from './modules/sessionMetricsStore';

const CS_HOME = path.join(os.homedir(), '.cybershuttle');

const logger = Logger.getInstance();
let sessions: SlurmSession[] = [];
let sessionsDir = '';

const isUuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const recordPath = (id: string): string => path.join(sessionsDir, `${id}.json`);
const isRecordFile = (name: string): boolean => name.endsWith('.json');

function readAllRecords(): SlurmSession[] {
    try {
        return fs.readdirSync(sessionsDir).filter(isRecordFile)
            .map(n => readJson<SlurmSession>(path.join(sessionsDir, n)))
            .filter((s): s is SlurmSession => !!s);
    }
    catch { return []; }
}

// Keeps the on-disk windowPids so a record write can't clobber another window's pids.
function writeRecord(session: SlurmSession): void {
    updateJson<SlurmSession>(recordPath(session.id), cur => toPersistedRecord(session, cur?.windowPids),
        err => logger.error(`Failed to save session ${session.id}`, err));
}

// One-time migration of the legacy sessions.json array.
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

// The one status-write path: set status (and, when given, errorMessage) and persist.
export function setStatus(session: SlurmSession, status: SlurmSession['status'], errorMessage?: string): void {
    session.status = status;
    if (errorMessage !== undefined) { session.errorMessage = errorMessage; }
    updateSession(session);
}

export function removeSession(sessionId: string) {
    const index = sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) { sessions.splice(index, 1); }
    deleteFile(recordPath(sessionId));
    deleteSessionMetrics(sessionId);
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

// Cross-window sync: reconcile in-memory from disk in place (never swap identity, so monitor/connect refs stay valid).
export function watchSessions(callback: () => void): fs.FSWatcher {
    return fs.watch(sessionsDir, (_event, filename) => {
        if (filename && !isRecordFile(filename)) { return; }
        if (mergeFromDisk(sessions, readAllRecords())) { callback(); }
    });
}

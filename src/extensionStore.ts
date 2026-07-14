import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { uuidv7 } from 'uuidv7';
import { Logger } from './logger';
import { lock, release, isPidAlive, readJsonArray, updateJsonArray, watchDirFile } from './modules/fsSupport';
import { SlurmSession } from './models';
import { mergeFromDisk, upsertRecord } from './modules/sessionStore';

export const CS_HOME = path.join(os.homedir(), '.cybershuttle');

const logger = Logger.getInstance();
let sessions: SlurmSession[] = [];
let sessionsFilePath: string = '';

const isUuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export function initSessionStore(storagePath: string = CS_HOME): string {
    fs.mkdirSync(storagePath, { recursive: true });
    sessionsFilePath = path.join(storagePath, 'sessions.json');
    lock(sessionsFilePath);
    try {
        sessions = JSON.parse(fs.readFileSync(sessionsFilePath, 'utf-8'));
        let idsMigrated = false;
        for (const s of sessions) {
            // The relay is gone after a reload; demote so the UI offers Connect (which reattaches from the persisted refs).
            if (s.status === 'connected' || s.status === 'connecting') { s.status = 'ready_to_connect'; }
            // A prompt that outlived its window can't be answered anymore; surface it as interrupted (offers Retry).
            if (s.status === 'awaiting_input') { s.status = 'interrupted'; }
            if (!isUuid(s.id)) { s.id = uuidv7(); idsMigrated = true; }
        }
        // Persist migrated ids now, in-lock: a changed id would otherwise duplicate on the next id-keyed upsert.
        if (idsMigrated) { fs.writeFileSync(sessionsFilePath, JSON.stringify(sessions, null, 2), 'utf-8'); }
        logger.info(`Loaded ${sessions.length} session(s) from ${sessionsFilePath}`);
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.info(`No existing sessions in ${sessionsFilePath}. initializing as empty`);
        }
        else {
            logger.error(`Failed to load sessions from ${sessionsFilePath}. initializing as empty`, err);
        }
        sessions = [];
    }
    finally {
        release(sessionsFilePath);
    }
    return sessionsFilePath;
}

const readSessionsFromDisk = (): SlurmSession[] => readJsonArray<SlurmSession>(sessionsFilePath);

// Field-scoped read-modify-write under the cross-process lock: the mutator edits the fresh on-disk array, so a
// write for one session never clobbers a sibling another window changed concurrently.
function writeSessionsFile(mutate: (disk: SlurmSession[]) => void): void {
    updateJsonArray<SlurmSession>(sessionsFilePath, (disk) => { mutate(disk); return disk; },
        err => logger.error(`Failed to save sessions to ${sessionsFilePath}`, err));
}

export function getAllSessions(): SlurmSession[] {
    return sessions;
}

export function addSession(session: SlurmSession) {
    sessions.push(session);
    writeSessionsFile(disk => upsertRecord(disk, session));
}

export function updateSession(session: SlurmSession) {
    const index = sessions.findIndex(s => s.id === session.id);
    if (index === -1) { return; }
    sessions[index] = session; // keep the array on the caller's current instance (merge-in-place keeps it fresh)
    writeSessionsFile(disk => upsertRecord(disk, session));
}

export function removeSession(sessionId: string) {
    const index = sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) { sessions.splice(index, 1); }
    writeSessionsFile((disk) => {
        const j = disk.findIndex(s => s.id === sessionId);
        if (j !== -1) { disk.splice(j, 1); }
    });
}

export function getSession(sessionId: string): SlurmSession | undefined {
    return sessions.find(s => s.id === sessionId);
}

export function mutateWindowPids(sessionId: string, transform: (pids: number[]) => number[]): void {
    writeSessionsFile((disk) => {
        const d = disk.find(s => s.id === sessionId);
        if (!d) { return; }
        d.windowPids = transform(d.windowPids ?? []);
        const mem = sessions.find(s => s.id === sessionId);
        if (mem) { mem.windowPids = d.windowPids; }
    });
}

export function liveAndCleanup(s: SlurmSession): { isCurrent: boolean; windowAlive: boolean } {
    const pids = s.windowPids ?? [];
    const live = pids.filter(isPidAlive);
    if (live.length !== pids.length) { mutateWindowPids(s.id, () => live); }
    return { isCurrent: live.includes(process.pid), windowAlive: live.length > 0 };
}

// Cross-window sync: another window wrote sessions.json. Merge disk state onto our existing instances in place
// (never swap identity) so references held by the monitor / in-flight connect stay valid and auto-refresh.
export function watchSessions(callback: () => void): fs.FSWatcher {
    return watchDirFile(CS_HOME, 'sessions.json', () => {
        lock(sessionsFilePath);
        try { mergeFromDisk(sessions, readSessionsFromDisk()); }
        finally { release(sessionsFilePath); }
        callback();
    });
}

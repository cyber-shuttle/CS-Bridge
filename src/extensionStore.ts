import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { SlurmSession } from './models';

export const CS_HOME = path.join(os.homedir(), '.cybershuttle');

const logger = Logger.getInstance();
let sessions: SlurmSession[] = [];
let sessionsFilePath: string = '';

export function initSessionStore(storagePath: string = CS_HOME): string {
    fs.mkdirSync(storagePath, { recursive: true });
    sessionsFilePath = path.join(storagePath, 'sessions.json');
    try {
        const loaded: SlurmSession[] = JSON.parse(fs.readFileSync(sessionsFilePath, 'utf-8'));
        sessions = loaded.map(s => { s.connectionInfo = undefined; return s; });
        logger.info(`Loaded ${sessions.length} session(s) from ${sessionsFilePath}`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.info(`No existing sessions in ${sessionsFilePath}. initializing as empty`);
        } else {
            logger.error(`Failed to load sessions from ${sessionsFilePath}. initializing as empty`, err);
        }
        sessions = [];
    }
    return sessionsFilePath;
}

function readSessionsFromDisk(): SlurmSession[] {
    try { return JSON.parse(fs.readFileSync(sessionsFilePath, 'utf-8')); } catch { return []; }
}

// Preserves windowPid from disk - patchSession owns that field via atomic field-level write.
function saveToFile(): void {
    try {
        const onDisk = readSessionsFromDisk();
        const sanitized = sessions.map(s => ({ ...s, connectionInfo: undefined, windowPid: onDisk.find(x => x.id === s.id)?.windowPid }));
        fs.writeFileSync(sessionsFilePath, JSON.stringify(sanitized, null, 2), 'utf-8');
    } catch (err) { logger.error(`Failed to save sessions to ${sessionsFilePath}`, err); }
}

export function getAllSessions(): SlurmSession[] {
    return sessions;
}

export function addSession(session: SlurmSession) {
    sessions.push(session);
    saveToFile();
}

export function updateSession(updatedSession: SlurmSession) {
    const index = sessions.findIndex(s => s.id === updatedSession.id);
    if (index !== -1) {
        sessions[index] = updatedSession;
        saveToFile();
    }
}

export function deleteSession(sessionId: string) {
    const index = sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) {
        sessions.splice(index, 1);
        saveToFile();
    }
}

export function findSession(sessionId: string): SlurmSession | undefined {
    return sessions.find(s => s.id === sessionId);
}

// Atomic field-level patch - saveToFile's whole-array write would clobber it otherwise.
export function patchSession(sessionId: string, patch: Partial<SlurmSession>): void {
    const memSession = sessions.find(x => x.id === sessionId);
    if (memSession) { Object.assign(memSession, patch); }
    const onDisk = readSessionsFromDisk();
    const s = onDisk.find(s => s.id === sessionId);
    if (!s) { return; }
    Object.assign(s, patch);
    try { fs.writeFileSync(sessionsFilePath, JSON.stringify(onDisk, null, 2), 'utf-8'); }
    catch (err) { logger.error('patchSession failed', err); }
}

// Reloads in-memory state before notifying. connectionInfo is in-memory only; preserved across reload.
export function watchSessions(callback: () => void): fs.FSWatcher {
    return fs.watch(CS_HOME, (_, filename) => {
        if (filename !== 'sessions.json') { return; }
        const oldById = new Map(sessions.map(s => [s.id, s]));
        sessions = readSessionsFromDisk().map(s => ({ ...s, connectionInfo: oldById.get(s.id)?.connectionInfo }));
        callback();
    });
}

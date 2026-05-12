import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { lock, release } from './modules/fsSupport';
import { SlurmSession } from './models';

export const CS_HOME = path.join(os.homedir(), '.cybershuttle');

const logger = Logger.getInstance();
let sessions: SlurmSession[] = [];
let sessionsFilePath: string = '';

export function initSessionStore(storagePath: string = CS_HOME): string {
    fs.mkdirSync(storagePath, { recursive: true });
    sessionsFilePath = path.join(storagePath, 'sessions.json');
    lock(sessionsFilePath);
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
    } finally {
        release(sessionsFilePath);
    }
    return sessionsFilePath;
}

function readSessionsFromDisk(): SlurmSession[] {
    try { return JSON.parse(fs.readFileSync(sessionsFilePath, 'utf-8')); } catch { return []; }
}

// Preserves windowPids from disk - mutateWindowPids owns that field via atomic field-level write.
function saveToFile(): void {
    lock(sessionsFilePath);
    try {
        const onDisk = readSessionsFromDisk();
        const sanitized = sessions.map(s => ({ ...s, connectionInfo: undefined, windowPids: onDisk.find(x => x.id === s.id)?.windowPids }));
        fs.writeFileSync(sessionsFilePath, JSON.stringify(sanitized, null, 2), 'utf-8');
    } catch (err) {
        logger.error(`Failed to save sessions to ${sessionsFilePath}`, err);
        vscode.window.showErrorMessage(`Failed to save sessions: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        release(sessionsFilePath);
    }
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

// Locked read-modify-write on windowPids. Used for window registration/unregistration and dead-pid cleanup.
export function mutateWindowPids(sessionId: string, transform: (pids: number[]) => number[]): void {
    lock(sessionsFilePath);
    try {
        const onDisk = readSessionsFromDisk();
        const diskIdx = onDisk.findIndex(s => s.id === sessionId);
        if (diskIdx < 0) { return; }
        const newPids = transform(onDisk[diskIdx].windowPids ?? []);
        onDisk[diskIdx].windowPids = newPids;
        const memSession = sessions.find(s => s.id === sessionId);
        if (memSession) { memSession.windowPids = newPids; }
        fs.writeFileSync(sessionsFilePath, JSON.stringify(onDisk, null, 2), 'utf-8');
    } finally {
        release(sessionsFilePath);
    }
}

// Cross-window sync: sessions.json is shared across windows; reload in-mem state when another window writes (preserve connectionInfo since it's in-mem only).
export function watchSessions(callback: () => void): fs.FSWatcher {
    return fs.watch(CS_HOME, (_, filename) => {
        if (filename !== 'sessions.json') { return; }
        lock(sessionsFilePath);
        try {
            const oldById = new Map(sessions.map(s => [s.id, s]));
            sessions = readSessionsFromDisk().map(s => ({ ...s, connectionInfo: oldById.get(s.id)?.connectionInfo }));
        } finally {
            release(sessionsFilePath);
        }
        callback();
    });
}

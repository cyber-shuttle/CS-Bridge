import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './logger';
import { SlurmSession } from './models';

const ONGOING_STATUSES: Set<string> = new Set([
    'configuring',
    'submitting',
    'deploying_agent',
    'pending',
    'running',
    'ready_to_connect',
    'connecting',
    'connected',
    'cancelling',
]);
const logger = Logger.getInstance();
let sessions: SlurmSession[] = [];
let sessionsFilePath: string = '';

export async function initSessionStore(storagePath: string): Promise<void> {
    sessionsFilePath = path.join(storagePath, 'sessions.json');
    try {
        const data = await fs.readFile(sessionsFilePath, 'utf-8');
        const loaded: SlurmSession[] = JSON.parse(data);
        sessions = loaded.map(s => {
            s.connectionInfo = undefined; // clear stale connectionInfo on load
            if (ONGOING_STATUSES.has(s.status)) {
                s.status = 'connection_broken';
            }
            return s;
        });
        logger.info(`Loaded ${sessions.length} session(s) from ${sessionsFilePath}`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.info(`No existing sessions in ${sessionsFilePath}. initializing as empty`);
        } else {
            logger.error(`Failed to load sessions from ${sessionsFilePath}. initializing as empty`, err);
        }
        sessions = [];
    }
}

async function saveToFile(): Promise<void> {
    try {
        const sanitized = sessions.map(s => {
            const copy = { ...s };
            copy.connectionInfo = undefined; // clear connectionInfo on save
            return copy;
        });
        await fs.writeFile(sessionsFilePath, JSON.stringify(sanitized, null, 2), 'utf-8');
    } catch (err) {
        logger.error(`Failed to save sessions to ${sessionsFilePath}`, err);
        throw err;
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

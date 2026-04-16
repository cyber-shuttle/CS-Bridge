import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from './logger';
import { SlurmSession } from './models';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);
const SESSIONS_FILENAME = 'sessions.json';

let sessions: SlurmSession[] = [];
let sessionsFilePath: string = '';

export async function init(storagePath: string): Promise<void> {
    sessionsFilePath = path.join(storagePath, SESSIONS_FILENAME);
    try {
        const data = await fs.readFile(sessionsFilePath, 'utf-8');
        const loaded: SlurmSession[] = JSON.parse(data);
        sessions = loaded.map(s => {
            const { connectionInfo, ...rest } = s as SlurmSession & { connectionInfo?: unknown };
            if (!TERMINAL_STATUSES.has(rest.status)) {
                rest.status = 'connection_broken';
            }
            return rest;
        });
    } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            sessions = [];
        } else {
            Logger.getInstance().warn('Failed to load sessions from file, starting fresh', err);
            sessions = [];
        }
    }
}

async function saveToFile(): Promise<void> {
    if (!sessionsFilePath) {
        return;
    }
    try {
        const sanitized = sessions.map(({ connectionInfo, ...rest }) => rest);
        await fs.writeFile(sessionsFilePath, JSON.stringify(sanitized, null, 2), 'utf-8');
    } catch (err: unknown) {
        Logger.getInstance().error('Failed to save sessions to file', err);
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

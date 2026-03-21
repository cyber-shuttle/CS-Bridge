import { SlurmSession } from "./models";

// TODO: Replace with actual persistent storage (e.g., globalState, file, etc.)
const sessions: SlurmSession[] = [
    {
        id: 'session1', name: 'Session 1',
        cluster: 'Cluster A', status: 'running', tunnelType: 'devtunnel',
        tunnelId: 'tunnel1', tunnelUrl: 'http://localhost:3000',
        jobId: '12345', queue: 'gpu', wallTime: '01:00:00',
        gpuCount: 2, gpuClass: 'A100', cpus: 16, memory: '64GB',
        jobDirectory: '/home/user/job1', allocation: 'allocation1',
        submittedAt: Date.now() - 3600000, errorMessage: ''
    },
];

export function getAllSessions(): SlurmSession[] {
    // Placeholder for fetching all sessions from persistent storage (e.g., globalState, file, etc.)
    return sessions;
}

export function addSession(session: SlurmSession) {
    // Placeholder for adding a session to persistent storage (e.g., globalState, file, etc.)
    sessions.push(session);
}

export function updateSession(updatedSession: SlurmSession) {
    // Placeholder for updating a session in persistent storage (e.g., globalState, file, etc.)
    const index = sessions.findIndex(s => s.id === updatedSession.id);
    if (index !== -1) {
        sessions[index] = updatedSession;
    }
}

export function deleteSession(sessionId: string) {
    // Placeholder for deleting a session from persistent storage (e.g., globalState, file, etc.)
    const index = sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) {
        sessions.splice(index, 1);
    }
}
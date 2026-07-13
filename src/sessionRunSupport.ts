import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { lock, release } from './modules/fsSupport';
import { CS_HOME } from './extensionStore';
import { SshManager } from './modules/sshSupport';
import { parseSacctUtil } from './modules/slurmParse';
import { RunMetrics, SessionRunRecord, SlurmSession } from './models';

// Status of finished runs, in a JSON file (~/.cybershuttle/runs.json)

const logger = Logger.getInstance();
const RUNS_FILE = path.join(CS_HOME, 'runs.json');
// No -X: usage (MaxRSS, TRESUsageInTot) lives on the .batch step rows, which parseSacctUtil turns into efficiency.
const SACCT = 'sacct -P -n --format=JobID,AllocCPUs,ReqMem,CPUTimeRAW,ElapsedRaw,MaxRSS,AllocTRES,TRESUsageInTot -j';
const MAX_RUNS = 200;

const changed = new vscode.EventEmitter<void>();
export const onDidChangeRuns = changed.event; // fires after a run is stored, so the Stats view / open summary refresh

function readRuns(): SessionRunRecord[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf-8'));
        return Array.isArray(parsed) ? parsed : []; // ENOENT on first run, or a corrupt/hand-edited file → start fresh
    }
    catch { return []; }
}

// Pull: newest-first history for the Stats view.
export function getSessionRuns(): SessionRunRecord[] {
    return readRuns().sort((a, b) => b.endedAt - a.endedAt);
}

export async function recordSessionRun(session: SlurmSession): Promise<void> {
    if (!session.jobId) { return; }
    const metrics = await fetchMetrics(session);
    let stored = false;
    lock(RUNS_FILE);
    try {
        const runs = readRuns();
        if (!runs.some(r => r.cluster === session.cluster && r.jobId === session.jobId)) {
            runs.push({ sessionId: session.id, sessionName: session.name, cluster: session.cluster, jobId: session.jobId, submittedAt: session.submittedAt, endedAt: Date.now(), finalStatus: session.status, metrics });
            fs.writeFileSync(`${RUNS_FILE}.tmp`, JSON.stringify(runs.slice(-MAX_RUNS), null, 2), 'utf-8');
            fs.renameSync(`${RUNS_FILE}.tmp`, RUNS_FILE);
            stored = true;
        }
    }
    catch (err) { logger.error('Failed to record run', err); }
    finally { release(RUNS_FILE); }
    if (stored) { changed.fire(); }
}

async function fetchMetrics(session: SlurmSession): Promise<RunMetrics | undefined> {
    try {
        const r = await SshManager.getInstance().runRemoteCommand(session.cluster, `${SACCT} ${session.jobId} 2>/dev/null`, undefined, { batch: true });
        const m = r.code === 0 ? parseSacctUtil(r.stdout) : undefined;
        return m && Object.keys(m).length ? m : undefined;
    }
    catch { return undefined; }
}

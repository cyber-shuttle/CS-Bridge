import * as path from 'path';
import { Logger } from './logger';
import { readJsonArray, updateJsonArray, watchDirFile } from './modules/fsSupport';
import { CS_HOME } from './extensionStore';
import { SshManager } from './modules/sshSupport';
import { parseSacctUtil } from './modules/slurmParse';
import { RunMetrics, SessionRunRecord, SlurmSession } from './models';

const logger = Logger.getInstance();
const RUNS_FILE = path.join(CS_HOME, 'runs.json');
// No -X keeps the .batch step rows that carry usage (MaxRSS, TotalCPU); --units=K puts every memory field in KiB.
const SACCT = 'sacct -P -n --units=K --format=JobID,AllocCPUs,ReqMem,ElapsedRaw,CPUTimeRAW,MaxRSS,TotalCPU -j';
const RUNS_PER_SESSION = 10;
const MAX_RUNS = 200;
// slurmdbd flushes step-level accounting (MaxRSS/usage) a beat after the job ends, so re-query until it lands before
// freezing the record — otherwise a run recorded the instant it's stopped is stuck with allocation-only, no efficiency.
const METRIC_RETRIES = 2;
const METRIC_RETRY_MS = 3000;

const readRuns = (): SessionRunRecord[] => readJsonArray<SessionRunRecord>(RUNS_FILE);

export function getSessionRuns(): SessionRunRecord[] {
    return readRuns().sort((a, b) => b.endedAt - a.endedAt);
}

export const watchRuns = (callback: () => void) => watchDirFile(CS_HOME, 'runs.json', callback);

const isSameRun = (r: SessionRunRecord, s: SlurmSession) => r.cluster === s.cluster && r.jobId === s.jobId;

export async function recordSessionRun(session: SlurmSession): Promise<void> {
    if (!session.jobId) { return; }
    const alreadyRecorded = readRuns().some(r => isSameRun(r, session));
    if (alreadyRecorded) { return; }
    const metrics = await fetchMetrics(session);
    const record: SessionRunRecord = { sessionId: session.id, sessionName: session.name, cluster: session.cluster, jobId: session.jobId, endedAt: Date.now(), finalStatus: session.status, metrics };
    updateJsonArray<SessionRunRecord>(RUNS_FILE,
        runs => runs.some(r => isSameRun(r, session)) ? null : capRuns([...runs, record]),
        err => logger.error('Failed to record run', err));
}

function capRuns(runs: SessionRunRecord[]): SessionRunRecord[] {
    const bySession = new Map<string, SessionRunRecord[]>();
    for (const r of runs) {
        const group = bySession.get(r.sessionId);
        if (group) { group.push(r); }
        else { bySession.set(r.sessionId, [r]); }
    }
    return [...bySession.values()]
        .flatMap(g => g.sort((a, b) => b.endedAt - a.endedAt).slice(0, RUNS_PER_SESSION))
        .sort((a, b) => b.endedAt - a.endedAt).slice(0, MAX_RUNS);
}

async function fetchMetrics(session: SlurmSession): Promise<RunMetrics | undefined> {
    for (let attempt = 0; ; attempt++) {
        const m = await sacctMetrics(session);
        if ((m && m.maxRss !== undefined) || attempt >= METRIC_RETRIES) { return m; }
        await new Promise(res => setTimeout(res, METRIC_RETRY_MS));
    }
}

async function sacctMetrics(session: SlurmSession): Promise<RunMetrics | undefined> {
    try {
        const r = await SshManager.getInstance().runRemoteCommand(session.cluster, `${SACCT} ${session.jobId} 2>/dev/null`, undefined, { batch: true });
        const m = r.code === 0 ? parseSacctUtil(r.stdout) : undefined;
        return m && Object.keys(m).length ? m : undefined;
    }
    catch { return undefined; }
}

import { Logger } from './logger';
import { SshManager } from './modules/sshSupport';
import { parseSacctUtil } from './modules/slurmParse';
import { readAllRuns, readSessionRuns, readSessionMetrics, readSessionStats, appendRun, clearAllRuns, watchSessionMetrics } from './modules/sessionMetricsStore';
import { Stats, SessionRunRecord, SlurmSession } from './models';

const logger = Logger.getInstance();
const SACCT = 'sacct -P -n --units=K --format=JobID,AllocCPUs,ReqMem,ElapsedRaw,CPUTimeRAW,MaxRSS,TotalCPU -j';
// slurmdbd flushes step usage a beat after the job ends, so re-query until MaxRSS lands before freezing the record.
const METRIC_RETRIES = 2;
const METRIC_RETRY_MS = 3000;

export const getSessionRuns = (): SessionRunRecord[] => readAllRuns();
export const clearSessionRuns = (): void => clearAllRuns();
export const watchRuns = (callback: () => void) => watchSessionMetrics(callback);

const isSameRun = (r: SessionRunRecord, s: SlurmSession) => r.cluster === s.cluster && r.jobId === s.jobId;

export async function recordSessionRun(session: SlurmSession): Promise<void> {
    if (!session.jobId) { return; }
    if (readSessionRuns(session.id).some(r => isSameRun(r, session))) { return; }
    const stats = await fetchStats(session) ?? readSessionStats(session.id); // fall back to the last in-run copy if the end query came back empty
    const record: SessionRunRecord = { sessionId: session.id, cluster: session.cluster, jobId: session.jobId, endedAt: Date.now(), finalStatus: session.status, stats, metrics: readSessionMetrics(session.id), allocation: session.allocation, queue: session.queue };
    appendRun(record, err => logger.error('Failed to record run', err));
}

async function fetchStats(session: SlurmSession): Promise<Stats | undefined> {
    for (let attempt = 0; ; attempt++) {
        const m = await sacctStats(session);
        if ((m && m.maxRss !== undefined) || attempt >= METRIC_RETRIES) { return m; }
        await new Promise(res => setTimeout(res, METRIC_RETRY_MS));
    }
}

// One sacct read (no flush-retry) — the monitor calls this during a run to keep the live stats copy non-stale.
export async function sacctStats(session: SlurmSession): Promise<Stats | undefined> {
    try {
        const r = await SshManager.getInstance().runRemoteCommand(session.cluster, `${SACCT} ${session.jobId} 2>/dev/null`, undefined, { batch: true });
        const m = r.code === 0 ? parseSacctUtil(r.stdout) : undefined;
        return m && Object.keys(m).length ? m : undefined;
    }
    catch { return undefined; }
}

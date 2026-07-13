import * as fs from 'fs';
import * as path from 'path';
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
const RUNS_PER_SESSION = 10;
const MAX_RUNS = 200;
// slurmdbd flushes step-level accounting (MaxRSS/usage) a beat after the job ends, so re-query until it lands before
// freezing the record — otherwise a run recorded the instant it's stopped is stuck with allocation-only, no efficiency.
const METRIC_RETRIES = 2;
const METRIC_RETRY_MS = 3000;

function readRuns(): SessionRunRecord[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf-8'));
        return Array.isArray(parsed) ? parsed : []; // ENOENT on first run, or a corrupt/hand-edited file → start fresh
    }
    catch { return []; }
}

export function getSessionRuns(): SessionRunRecord[] {
    return readRuns().sort((a, b) => b.endedAt - a.endedAt);
}

// Fires when runs.json changes in any window. Lenient match: a tmp+rename write can surface as 'runs.json' or a null
// filename, so accept either.
export function watchRuns(callback: () => void): fs.FSWatcher {
    return fs.watch(CS_HOME, (_, filename) => { if (!filename || filename === 'runs.json') { callback(); } });
}

const isSameRun = (r: SessionRunRecord, s: SlurmSession) => r.cluster === s.cluster && r.jobId === s.jobId;

export async function recordSessionRun(session: SlurmSession): Promise<void> {
    if (!session.jobId) { return; }
    if (readRuns().some(r => isSameRun(r, session))) { return; } // already recorded by another end path — skip the sacct fetch
    const metrics = await fetchMetrics(session);
    lock(RUNS_FILE);
    try {
        const runs = readRuns();
        if (!runs.some(r => isSameRun(r, session))) {
            runs.push({ sessionId: session.id, sessionName: session.name, cluster: session.cluster, jobId: session.jobId, endedAt: Date.now(), finalStatus: session.status, metrics });
            fs.writeFileSync(`${RUNS_FILE}.tmp`, JSON.stringify(capRuns(runs), null, 2), 'utf-8');
            fs.renameSync(`${RUNS_FILE}.tmp`, RUNS_FILE);
        }
    }
    catch (err) { logger.error('Failed to record run', err); }
    finally { release(RUNS_FILE); }
}

// Keep each session's RUNS_PER_SESSION most-recent runs, then a global MAX_RUNS backstop — both newest-first by endedAt.
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

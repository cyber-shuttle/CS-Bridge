import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Metric, METRICS_HISTORY_LEN, Stats, SessionRunRecord } from '../models';
import { readJson, updateJson, deleteFile } from './fsSupport';

// One file per session: metrics/{id}.json = { runs, metrics, stats } — finished-run history, live samples, live sacct
// copy, each written independently. Per-file locked, so writes never contend across sessions.
const METRICS_DIR = path.join(os.homedir(), '.cybershuttle', 'metrics');
const filePath = (id: string): string => path.join(METRICS_DIR, `${id}.json`);
const RUNS_PER_SESSION = 10;

interface MetricsFile { runs?: SessionRunRecord[]; metrics?: Metric[]; stats?: Stats }

const read = (id: string): MetricsFile => readJson<MetricsFile>(filePath(id)) ?? {};
function sessionIds(): string[] {
    try { return fs.readdirSync(METRICS_DIR).filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length)); }
    catch { return []; }
}

const mutate = (id: string, fn: (cur: MetricsFile) => MetricsFile): void => {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    updateJson<MetricsFile>(filePath(id), cur => fn(cur ?? {}));
};

// live samples — append one, capped to the rolling window
export function appendMetric(id: string, sample: Metric): void {
    mutate(id, cur => ({ ...cur, metrics: [...(cur.metrics ?? []), sample].slice(-METRICS_HISTORY_LEN) }));
}
export const readSessionMetrics = (id: string): Metric[] => read(id).metrics ?? [];

// live sacct copy
export const writeSessionStats = (id: string, stats: Stats): void => mutate(id, cur => ({ ...cur, stats }));
export const readSessionStats = (id: string): Stats | undefined => read(id).stats;

// reset the live block for a fresh run, keeping the run history
export const resetLive = (id: string): void => mutate(id, cur => ({ runs: cur.runs }));

export function readSessionRuns(id: string): SessionRunRecord[] {
    return read(id).runs ?? [];
}

export function readAllRuns(): SessionRunRecord[] {
    return sessionIds().flatMap(id => read(id).runs ?? []).sort((a, b) => b.endedAt - a.endedAt);
}

// Deduped by cluster+jobId, newest-first, capped. null → already recorded.
export function mergeRun(existing: SessionRunRecord[], record: SessionRunRecord): SessionRunRecord[] | null {
    if (existing.some(r => r.cluster === record.cluster && r.jobId === record.jobId)) { return null; }
    return [record, ...existing].sort((a, b) => b.endedAt - a.endedAt).slice(0, RUNS_PER_SESSION);
}

export function appendRun(record: SessionRunRecord, onError?: (err: unknown) => void): void {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    updateJson<MetricsFile>(filePath(record.sessionId), (cur) => {
        const runs = mergeRun(cur?.runs ?? [], record);
        return runs === null ? null : { ...cur, runs };
    }, onError);
}

export function clearAllRuns(): void {
    for (const id of sessionIds()) { updateJson<MetricsFile>(filePath(id), cur => (cur ? { ...cur, runs: [] } : null)); }
}

export function deleteSessionMetrics(id: string): void {
    deleteFile(filePath(id));
}

export function watchSessionMetrics(callback: () => void): fs.FSWatcher {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
    return fs.watch(METRICS_DIR, (_event, name) => { if (!name || name.endsWith('.json')) { callback(); } });
}

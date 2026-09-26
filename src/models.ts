import type { PlaneRun } from './control';

export interface SlurmSession extends Session {
    jobId: string;
    queue: string;
    wallTime: string;
    gpuCount: number;
    gpuClass: string;
    cpus: number;
    memory: string;
    allocation: string;
    batchScript?: string;
}

// Lifecycle: not_started → submitting → queued → preparing (job running, link not up yet) →
// ready_to_connect → connecting → connected; stopping → stopped/failed.
// Job end (completed or wall-time killed) → stopped (restartable).
interface Session {
    id: string;
    planeId?: string;
    name: string;
    cluster: string;
    status:
        | 'not_started' | 'submitting' | 'queued' | 'preparing'
        | 'ready_to_connect' | 'connecting' | 'connected'
        | 'stopping' | 'stopped' | 'failed';
    submittedAt: number;
    startedAt?: number;
    errorMessage: string;
    workingDirectory?: string;
}

export interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
    extraDirectives?: string[]; // "Key Value" ssh_config lines other than HostName/User
    source?: 'user' | 'system'; // user is editable, system is read-only
}

export interface SlurmClusterInfo {
    host: string;
    accounts: string[];
    partitions: SlurmPartitionInfo[];
    homeDir?: string;
}

export interface SlurmPartitionInfo {
    name: string;
    cpuCount: number;
    memory: string;
    gres: GresInfo[];
}

export interface GresInfo {
    name: string;
    count: number;
}

export enum SlurmJobStatus {
    QUEUED = 'queued',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
    TIMEOUT = 'timeout',
    OUT_OF_MEMORY = 'out_of_memory',
    UNKNOWN = 'unknown',
}

export type ViewSession = SlurmSession & { metrics?: Metric[] };

export const METRICS_HISTORY_LEN = 20; // rolling live-sample window, also the sparkline slot count
export const POLLING_INTERVAL_MS = 5000;

// A resource sample from linkspan's /metrics. atMs (when taken) is set once stored, for rate derivation.
export interface Metric {
    memBytes?: number;
    cpuUsageUsec?: number;
    gpus?: GpuStat[];
    atMs?: number;
}

export interface GpuStat {
    index: number;
    utilPct: number;
    memUsedMiB: number;
    memTotalMiB: number;
}

export interface Stats {
    cores?: number;
    requestedMemory?: string;
    elapsedSeconds?: number;
    maxRss?: string; // peak RSS, human-normalized (e.g. "1.2 GB")
    cpuEfficiencyPct?: number; // used / allocated CPU-seconds
    memoryEfficiencyPct?: number; // MaxRSS / requested memory
}

export interface StatsState {
    runs: PlaneRun[];
}

export interface SummaryState {
    session: SlurmSession;
    metrics?: Metric[]; // live sample history (sparklines)
    stats?: Stats; // sacct accounting; absent → the webview shows a "fetching…" spinner
}

// A host's runtime-details fetch is in exactly one phase; the draft form renders straight off it.
export type HostRuntime =
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; info: SlurmClusterInfo };

export interface SessionsState {
    isRemote: boolean;
    account?: string;
    sessions: ViewSession[];
    draftHost: string | null;
    hostRuntime: Record<string, HostRuntime>;
    validating: boolean;
    alert: { title: string; message: string } | null;
}

export interface HostsState {
    sshHosts: SshHost[];
}

// A message posted from a webview to its provider. Fields are optional; each command reads the ones it needs.
export interface WebviewMessage {
    command: string;
    sessionId?: string;
    host?: string;
    name?: string;
    queue?: string;
    wallTime?: string;
    gpu?: string;
    cpus?: string;
    memory?: string;
    allocation?: string;
    seq?: number;
}

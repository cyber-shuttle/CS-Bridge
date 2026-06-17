export interface SlurmSession extends Session {
    jobId: string;
    queue: string;
    wallTime: string;
    gpuCount: number;
    gpuClass: string;
    cpus: number;
    memory: string;
    jobDirectory: string;
    allocation: string;
    batchScript?: string;
    tunnelId?: string;
    tunnelCluster?: string;
}

// Lifecycle: not_started → submitting → queued → preparing (job + Step-1 sshd/tunnel) →
// ready_to_connect → connecting → connected; disconnected on a dropped link; stopping → stopped/failed/completed.
// An SSH auth prompt during launch shows as awaiting_input (reverts to submitting once answered); dismissing it → interrupted.
export interface Session {
    id: string;
    name: string;
    cluster: string;
    status: 'connecting' | 'connected' | 'ready_to_connect' | 'preparing' | 'failed' | 'completed' | 'queued' | 'submitting' | 'stopped' | 'not_started' | 'stopping' | 'disconnected' | 'awaiting_input' | 'interrupted';
    submittedAt: number;
    startedAt?: number;
    errorMessage: string;
    connectionInfo?: SessionConnectionInfo;
    workingDirectory?: string;
    windowPids?: number[];
}

// Required fields are persisted across reload (persistableConnectionInfo); optional ones are volatile/secret, in-memory only.
export interface SessionConnectionInfo {
    sshPort: number;
    sshTunnelId: string;
    region: string;
    sshTunnelForwardPort?: number;
    sshPassword?: string;
    sshPrivateKey?: string;
    apiTunnelId?: string;
    apiTunnelAccessToken?: string;
    apiPort?: number;
}

export function persistableConnectionInfo(ci: SessionConnectionInfo | undefined): SessionConnectionInfo | undefined {
    if (!ci?.sshTunnelId) { return undefined; }
    const { sshTunnelId, sshPort, region } = ci;
    return { sshTunnelId, sshPort, region };
}

// A remote command reports its SSH auth box opening and being answered so the caller can reflect
// "awaiting input" on the UI; a dismissed box instead rejects the command with PromptCancelledError,
// letting the caller treat it as a deliberate interruption rather than a failure.
export type PromptObserver = (event: 'opened' | 'answered') => void;

export class PromptCancelledError extends Error {}

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

export interface TunnelCredential {
    provider: 'devtunnel' | 'frp';
    authToken: string;
    serverUrl?: string;
}

export interface AccountInfo {
    label: string | null;
}

export enum SlurmJobStatus {
    PENDING = 'pending',
    RUNNING = 'running',
    COMPLETED = 'completed',
    FAILED = 'failed',
    CANCELLED = 'cancelled',
    TIMEOUT = 'timeout',
    OUT_OF_MEMORY = 'out_of_memory',
    UNKNOWN = 'unknown',
}

export type ViewSession = SlurmSession & { isCurrent: boolean; windowAlive: boolean };

// A host's runtime-details fetch is in exactly one phase; the draft form renders straight off it.
export type HostRuntime =
    | { phase: 'loading' }
    | { phase: 'awaiting' } // an SSH auth box is open
    | { phase: 'error'; message: string }
    | { phase: 'ready'; info: SlurmClusterInfo };

export interface SessionsState {
    isRemote: boolean;
    sessions: ViewSession[];
    draftHost: string | null;
    editingId: string | null;
    hostRuntime: Record<string, HostRuntime>;
    previewSession: SlurmSession | null;
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
}

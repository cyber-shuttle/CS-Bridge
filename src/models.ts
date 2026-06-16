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
    tunnelId?: string; // cs-bridge-owned Dev Tunnel id (hosted by linkspan, deleted on remove)
    tunnelCluster?: string; // its cluster id; linkspan needs it to resolve the tunnel
}

/*
Session status lifecycle (UI grouping in ui/logic/session.ts).

Launch (job lifecycle):
- not_started: created, never launched.
- submitting: submitting the batch job to SLURM (sbatch in flight).
- queued: accepted, waiting in the SLURM queue.
- preparing: running on the compute node; bringing up the remote sshd + tunnel (Step 1).

Connect:
- ready_to_connect: remote sshd + tunnel are live AND all connection-enabling info is persisted
  (sshTunnelId/sshPort/region in sessions.json + the SSH key on disk) - so the extension can
  initiate the connection with no login-node SSH calls, even after a reload.
- connecting: opening the local relay + a window (Step 2).
- connected: a VS Code window is attached over the tunnel.
- disconnected: not connected (failed to connect, or the live connection dropped); the job may
  still be alive - retry (Connect) or Stop. Stays monitored: goes terminal on job death.

Teardown / terminal:
- stopping: Stop requested; scancel in flight.
- stopped / failed / completed: terminal (user-stopped / errored / job finished cleanly); can be started again.
*/
export interface Session {
    id: string;
    name: string;
    cluster: string;
    status: 'connecting' | 'connected' | 'ready_to_connect' | 'preparing' | 'failed' | 'completed' | 'queued' | 'submitting' | 'stopped' | 'not_started' | 'stopping' | 'disconnected';
    submittedAt: number;
    startedAt?: number; // epoch ms when the job first started running; anchors the wall-time countdown
    errorMessage: string;
    connectionInfo?: SessionConnectionInfo;
    workingDirectory?: string;
    windowPids?: number[];
}

// Required fields are the refs persisted across reload (see persistableConnectionInfo); optional fields are volatile/secret, in-memory only.
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

// Persist only the non-secret refs needed to reattach after a reload; secrets + the ephemeral local port stay in memory.
export function persistableConnectionInfo(ci: SessionConnectionInfo | undefined): SessionConnectionInfo | undefined {
    if (!ci?.sshTunnelId) { return undefined; }
    const { sshTunnelId, sshPort, region } = ci;
    return { sshTunnelId, sshPort, region };
}

export interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
    args?: string[]; // extra ssh_config directives ("Key Value"), excluding HostName/User
    source?: 'user' | 'system'; // origin config; user is editable, system is read-only.
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
    UNKNOWN = 'unknown'
}

export type ViewSession = SlurmSession & { isCurrent: boolean; windowAlive: boolean };

/** State pushed to the Sessions view. */
export interface SessionsState {
    isRemote: boolean; // true in a cshost remote window (read-only, session-scoped view); false in the sidebar.
    sessions: ViewSession[];
    draftHost: string | null; // host chosen for a new session whose config card is showing; null when none in progress.
    editingId: string | null; // id of the session whose params are being edited inline; null when none.
    clusterInfo: Record<string, SlurmClusterInfo>;
    clusterErrors: Record<string, string>;
    previewSession: SlurmSession | null;
}

/** State pushed to the SSH Hosts view. */
export interface HostsState {
    sshHosts: SshHost[];
}
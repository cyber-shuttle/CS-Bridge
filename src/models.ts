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
    batchScript?: string; // Optional field to store the generated batch script content
}

/*
Job status lifecycle:

- not_started: Session is created but not yet launched.
- configuring: Session is being configured (e.g., fetching credentials, generating scripts).
- deploying_agent: Tunnel agent is being deployed to the cluster node.
- submitting: Job is being submitted to the cluster.
- pending: Job has been submitted to the cluster and is waiting in the queue.
- running: Job is currently running on the cluster.
- connected: Job is running and tunnel is connected, ready for user interaction.
- completed: Job has completed successfully.

Error states (Need proper handling and messaging for these):
- failed: Job has completed with a failure status.
- cancelling: Cancellation has been requested and is in progress.
- cancelled: Job has been cancelled.
- expired: Session has expired (e.g., tunnel expired, job ran out of time, etc.).
*/
export interface Session {
    id: string;
    name: string;
    cluster: string;
    status: 'configuring' | 'connected' | 'running' | 'failed' | 'completed' | 'pending' | 'submitting' | 'deploying_agent' | 'cancelled' | 'not_started' | 'cancelling' | 'expired';
    tunnelType: 'devtunnel' | 'cstunnel' | 'open';
    tunnelId: string;
    tunnelUrl: string;
    submittedAt: number;
    errorMessage: string;
    runtimeInfo?: SessionRuntimeInfo;
}

interface SessionRuntimeInfo {
    sshPort: number;
    logPort: number;
    tunnelUrl: string;
    tunnelToken: string;
    jobId: string;
}

export interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
}

export interface SlurmClusterInfo {
    host: string;
    accounts: string[];
    partitions: SlurmPartitionInfo[]
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
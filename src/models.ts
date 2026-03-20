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
}

export interface Session {
    id: string;
    name: string;
    cluster: string;
    status: 'running' | 'failed' | 'completed' | 'pending' | 'cancelled' | 'not_started';
    tunnelType: 'devtunnel' | 'cstunnel' | 'open';
    tunnelId: string;
    tunnelUrl: string;
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

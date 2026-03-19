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
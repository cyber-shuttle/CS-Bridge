export interface Session {
    id: string;
    name: string;
    cluster: string;
    status: 'running' | 'failed' | 'completed' | 'pending' | 'cancelled' | 'not_started';
}
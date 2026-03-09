export type EventType =
  | 'job_submit'
  | 'job_status_change'
  | 'ssh_connect'
  | 'tunnel_create'
  | 'linkspan_deploy'
  | 'auth_flow'
  | 'session_reconnect'
  | 'session_corrupted'
  | 'sinfo_fetch'
  | 'extension_activate';

export type EventStatus = 'success' | 'failure' | 'in_progress';

export interface MetricEvent {
  id?: number;
  timestamp: string;        // ISO 8601
  event_type: EventType;
  status: EventStatus;
  duration_ms?: number;
  error_message?: string;
  metadata: Record<string, unknown>;
  exported: boolean;
}

// Metadata payload shapes per event type
export interface JobSubmitMeta {
  cluster: string;
  cpu: string;
  gpu: string;
  memory: string;
  walltime_requested: string;
  job_id_slurm?: string;
}

export interface JobStatusChangeMeta {
  job_id_slurm: string;
  old_status: string;
  new_status: string;
  cluster: string;
}

export interface SshConnectMeta {
  target_host: string;
  auth_method?: string;
}

export interface TunnelCreateMeta {
  tunnel_type: 'devtunnel' | 'frp';
  target_host?: string;
}

export interface LinkspanDeployMeta {
  deploy_type: 'local' | 'remote';
  target_host?: string;
  version?: string;
}

export interface AuthFlowMeta {
  stage: 'device_code' | 'polling' | 'token_exchange' | 'token_refresh';
}

export interface SessionReconnectMeta {
  session_id: string;
  attempt_number: number;
}

export interface SinfoFetchMeta {
  cluster: string;
  raw_output_truncated?: string;
}

export interface ExtensionActivateMeta {
  vscode_version: string;
  extension_version: string;
}

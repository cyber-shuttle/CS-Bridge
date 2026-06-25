import { SlurmJobStatus, SlurmSession } from '../models';

type Status = SlurmSession['status'];

export interface StatusTransition {
    next?: Status;
    stopMonitoring?: boolean;
    error?: string;
}

// Session-status categories — the single source of truth shared by the provider, monitor, and webview UI.
const CONNECT_PHASE: Status[] = ['preparing', 'ready_to_connect', 'connecting', 'connected', 'disconnected'];
const TERMINAL: Status[] = ['stopped', 'failed', 'completed'];
// 'stopping' is excluded so Stop neither shows nor re-triggers while a stop is already in flight.
const STOPPABLE: Status[] = ['submitting', 'queued', 'preparing', 'ready_to_connect', 'connecting', 'connected', 'disconnected', 'unreachable'];
const RELAY_LIVE: Status[] = ['ready_to_connect', 'connecting', 'connected'];
// Non-relay-live statuses the monitor polls; an infra failure downgrades these (never a relay-live one) to 'unreachable'.
const MONITORABLE_OFFLINE: Status[] = ['submitting', 'queued', 'preparing', 'disconnected', 'unreachable'];

export const isTerminal = (status: Status): boolean => TERMINAL.includes(status);
export const isCloseable = (status: Status): boolean => isTerminal(status) || status === 'not_started' || status === 'interrupted';
export const isStoppable = (status: Status): boolean => STOPPABLE.includes(status);
export const isRelayLive = (status: Status): boolean => RELAY_LIVE.includes(status);

export const unreachableStatus = (status: Status): Status | undefined =>
    MONITORABLE_OFFLINE.includes(status) ? 'unreachable' : undefined;

export const isReattachable = (status: Status, hasRefs: boolean): boolean => !isTerminal(status) && hasRefs;

// RUNNING-while-'preparing' is handled by the monitor instead (side effects: scrape output, start remote prepare).
export function computeStatusTransition(current: Status, slurm: SlurmJobStatus): StatusTransition {
    switch (slurm) {
        case SlurmJobStatus.RUNNING:
            // Promote a freshly-running job to 'preparing'; never pull a connect-phase session back (would thrash reattach).
            return CONNECT_PHASE.includes(current) ? {} : { next: 'preparing' };
        case SlurmJobStatus.COMPLETED:
            return { next: 'completed', stopMonitoring: true };
        case SlurmJobStatus.FAILED:
        case SlurmJobStatus.TIMEOUT:
        case SlurmJobStatus.OUT_OF_MEMORY:
            return { next: 'failed', stopMonitoring: true, error: `Job ended with status: ${slurm}` };
        case SlurmJobStatus.PENDING:
            return { next: 'queued' };
        case SlurmJobStatus.CANCELLED:
            return { next: 'stopped', stopMonitoring: true };
        case SlurmJobStatus.UNKNOWN:
            // An unrecognized/blank sacct state (PREEMPTED, REQUEUED, COMPLETING, accounting lag) is not job death — hold.
            return {};
        default:
            return {};
    }
}

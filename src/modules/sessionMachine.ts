import { SlurmJobStatus, SlurmSession } from '../models';

type Status = SlurmSession['status'];

export function wallMs(wallTime: string): number {
    const p = (wallTime || '').split(':').map(Number);
    return ((p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0)) * 1000;
}

/** SLURM kills the job at --time, so a passed deadline is authoritative even when the login node is unreachable
 *  for `sacct`. Assumes death within KillWait of --time; OverTimeLimit clusters may run past it. */
export function isWallTimeExpired(session: Pick<SlurmSession, 'wallTime' | 'startedAt'>, now: number): boolean {
    const total = wallMs(session.wallTime);
    return session.startedAt !== undefined && total > 0 && now >= session.startedAt + total;
}

export interface StatusTransition {
    next?: Status;
    stopMonitoring?: boolean;
    error?: string;
}

// Session-status categories — the single source of truth shared by the provider, monitor, and webview UI.
const CONNECT_PHASE: Status[] = ['preparing', 'ready_to_connect', 'connecting', 'connected'];
const TERMINAL: Status[] = ['stopped', 'failed', 'completed'];
// 'stopping' is excluded so Stop neither shows nor re-triggers while a stop is already in flight.
const STOPPABLE: Status[] = ['submitting', 'queued', 'preparing', 'ready_to_connect', 'connecting', 'connected', 'unreachable'];
const RELAY_LIVE: Status[] = ['ready_to_connect', 'connecting', 'connected'];
// Non-relay-live statuses the monitor polls; an infra failure downgrades these (never a relay-live one) to 'unreachable'.
const MONITORABLE_OFFLINE: Status[] = ['submitting', 'queued', 'preparing', 'unreachable'];

export const isTerminal = (status: Status): boolean => TERMINAL.includes(status);
export const isCloseable = (status: Status): boolean => isTerminal(status) || status === 'not_started' || status === 'interrupted';
export const isStoppable = (status: Status): boolean => STOPPABLE.includes(status);
export const isRelayLive = (status: Status): boolean => RELAY_LIVE.includes(status);

export const unreachableStatus = (status: Status): Status | undefined =>
    MONITORABLE_OFFLINE.includes(status) ? 'unreachable' : undefined;

export const isReattachable = (status: Status, hasRefs: boolean): boolean => !isTerminal(status) && hasRefs;

// RUNNING-while-'preparing' is handled by the monitor instead (side effects: scrape output, start remote prepare).
export function computeStatusTransition(current: Status, slurm: SlurmJobStatus): StatusTransition {
    // A stopping session is tearing down; a still-live RUNNING/QUEUED reading (scancel/accounting lag) must not revive it.
    if (current === 'stopping' && (slurm === SlurmJobStatus.RUNNING || slurm === SlurmJobStatus.QUEUED)) { return {}; }
    switch (slurm) {
        case SlurmJobStatus.RUNNING:
            // Promote a freshly-running job to 'preparing'; never pull a connect-phase session back (would thrash reattach).
            return CONNECT_PHASE.includes(current) ? {} : { next: 'preparing' };
        case SlurmJobStatus.COMPLETED:
            return { next: 'completed', stopMonitoring: true };
        case SlurmJobStatus.FAILED:
        case SlurmJobStatus.OUT_OF_MEMORY:
            return { next: 'failed', stopMonitoring: true, error: `Job ended with status: ${slurm}` };
        case SlurmJobStatus.QUEUED:
            return { next: 'queued' };
        case SlurmJobStatus.TIMEOUT:
        case SlurmJobStatus.CANCELLED:
            // Wall-time reached or cancelled — the job is gone but the session can be restarted.
            return { next: 'stopped', stopMonitoring: true };
        case SlurmJobStatus.UNKNOWN:
            // An unrecognized/blank sacct state (PREEMPTED, REQUEUED, COMPLETING, accounting lag) is not job death — hold.
            return {};
        default:
            return {};
    }
}

import { SlurmJobStatus, SlurmSession } from "../models";

type Status = SlurmSession['status'];

export interface StatusTransition {
    next?: Status;            // the session status to move to, if any
    stopMonitoring?: boolean; // whether the job has reached a terminal state and polling should stop
    error?: string;          // errorMessage to record alongside a failure transition
}

// Connect-phase / disconnected states the poll loop must never drag back to 'preparing'.
const CONNECT_PHASE: Status[] = ['preparing', 'ready_to_connect', 'connected', 'connecting', 'disconnected'];

// Session-status categories — the single source of truth shared by the provider, the monitor, and the webview UI.
const TERMINAL: Status[] = ['stopped', 'failed', 'completed'];
const STOPPABLE: Status[] = ['submitting', 'queued', 'preparing', 'connecting', 'ready_to_connect', 'connected', 'disconnected', 'stopping'];
const RELAY_LIVE: Status[] = ['ready_to_connect', 'connecting', 'connected'];

// Terminal: the job has finished (stopped, failed, or completed); drop from monitoring, and it can be started again.
export const isTerminal = (status: Status): boolean => TERMINAL.includes(status);
// Closeable: removable from the list — terminal, or never started.
export const isCloseable = (status: Status): boolean => isTerminal(status) || status === 'not_started';
// Stoppable: has an in-flight job or a live/establishing connection that Stop can tear down.
export const isStoppable = (status: Status): boolean => STOPPABLE.includes(status);
// Relay live (or being established): the monitor health-pings the tunnel instead of polling SLURM.
export const isRelayLive = (status: Status): boolean => RELAY_LIVE.includes(status);

// Pure mapping from a polled SLURM job status to the session-status transition the monitor should apply.
// The RUNNING-while-'preparing' case is handled separately by the monitor because it has side effects
// (scraping the job output, kicking off remote prepare); everything else is a plain decision encoded here.
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
            return { next: 'failed', stopMonitoring: true, error: `Job ended with unknown status: ${slurm}` };
        default:
            return {};
    }
}

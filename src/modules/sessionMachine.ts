import { SlurmJobStatus, SlurmSession } from "../models";

type Status = SlurmSession['status'];

export interface StatusTransition {
    next?: Status;            // the session status to move to, if any
    stopMonitoring?: boolean; // whether the job has reached a terminal state and polling should stop
    error?: string;          // errorMessage to record alongside a failure transition
}

// Connect-phase / disconnected states the poll loop must never drag back to 'preparing'.
const CONNECT_PHASE: Status[] = ['preparing', 'ready_to_connect', 'connected', 'connecting', 'disconnected'];

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
            return { next: 'cancelled', stopMonitoring: true };
        case SlurmJobStatus.UNKNOWN:
            return { next: 'failed', stopMonitoring: true, error: `Job ended with unknown status: ${slurm}` };
        default:
            return {};
    }
}

// The parts of cs-control's wire vocabulary (docs/API.md there) these views read. It lives apart from the
// client so the webviews can name these shapes without pulling the client or its node imports into a
// browser bundle. Optional fields are the ones cs-control omits when unset.

export interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
    port?: number;
    identityFile?: string;
    key?: string; // the stored login key assigned to this host
    extraDirectives: string[];
    managed?: boolean; // written by this API, so the only entries it may change
}

export interface SshKey {
    name: string;
    type: string;
    fingerprint: string;
}

export interface SshHostTest {
    ok: boolean;
    message: string;
}

export interface RunStats {
    requestedMemory?: string;
    elapsedSeconds?: number;
    maxRss?: string;
    cpuEfficiencyPct?: number;
    memoryEfficiencyPct?: number;
}

// One finished run, named by the seq that ran it rather than by its session, so relaunching a
// session leaves the previous run standing.
export interface Run {
    sessionId: string;
    seq: number;
    finalState: string;
    startedAt?: string;
    endedAt: string;
    stats?: RunStats;
}

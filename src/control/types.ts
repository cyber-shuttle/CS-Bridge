// The cs-control wire vocabulary, as docs/API.md in cs-control defines it. It lives apart from the
// client so the webviews can name these shapes through `models.ts` without pulling the client, its
// fetch or its node imports into a browser bundle. Optional fields are the ones cs-control omits
// when unset, which is most of them: a host it did not resolve carries only its name.

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
    host: string;
    ok: boolean;
    message: string;
}

export interface RunStats {
    cores?: number;
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
    sshHost: string;
    account?: string;
    partition: string;
    rootFolder: string;
    resources: { cores: number; memoryMb: number; wallMinutes: number; gpuType?: string; gpuCount?: number };
    finalState: string;
    error?: string;
    startedAt?: string;
    endedAt: string;
    stats?: RunStats;
}

import type { Metric, SessionRunRecord } from '@/models';

// Cores busy per gap: Δcpu-usec / Δwall-usec. Gaps missing a cpu reading or with dt≤0 are dropped.
export function cpuCoreSeries(samples: Metric[]): number[] {
    return samples.flatMap((b, i) => {
        const a = samples[i - 1];
        if (!a || a.cpuUsageUsec === undefined || b.cpuUsageUsec === undefined || a.atMs === undefined || b.atMs === undefined) { return []; }
        const dtUsec = (b.atMs - a.atMs) * 1000;
        return dtUsec > 0 ? [(b.cpuUsageUsec - a.cpuUsageUsec) / dtUsec] : [];
    });
}

export function efficiencyColor(pct?: number): string {
    if (pct === undefined) { return 'var(--vscode-descriptionForeground)'; }
    if (pct >= 75) { return 'var(--vscode-charts-green)'; }
    if (pct >= 40) { return 'var(--vscode-charts-yellow)'; }
    return 'var(--vscode-errorForeground)';
}

export function fmtPct(pct?: number): string {
    return pct === undefined ? '—' : `${Math.round(pct)}%`;
}

// Group runs by session, preserving input order across groups (each session ordered by its most recent run) and within
// each group. Assumes `runs` is already newest-first, as getSessionRuns returns it; each group is non-empty.
export function groupRunsBySession(runs: SessionRunRecord[]): SessionRunRecord[][] {
    const byId = new Map<string, SessionRunRecord[]>();
    for (const run of runs) {
        const group = byId.get(run.sessionId);
        if (group) { group.push(run); }
        else { byId.set(run.sessionId, [run]); }
    }
    return [...byId.values()];
}

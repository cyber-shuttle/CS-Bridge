import type { SessionRunRecord } from '@/models';

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

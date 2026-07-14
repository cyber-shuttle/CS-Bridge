import type { SessionRunRecord } from '@/models';

export type EffSeverity = 'good' | 'ok' | 'poor' | 'unknown';

export function efficiencySeverity(pct?: number): EffSeverity {
    if (pct === undefined) { return 'unknown'; }
    if (pct >= 75) { return 'good'; }
    if (pct >= 40) { return 'ok'; }
    return 'poor';
}

export const SEVERITY_COLOR: Record<EffSeverity, string> = {
    good: 'var(--vscode-charts-green)',
    ok: 'var(--vscode-charts-yellow)',
    poor: 'var(--vscode-errorForeground)',
    unknown: 'var(--vscode-descriptionForeground)',
};

/** Efficiency % as "47%", or "—" when unknown. */
export function fmtPct(pct?: number): string {
    return pct === undefined ? '—' : `${Math.round(pct)}%`;
}

export interface SessionRunGroup {
    sessionId: string;
    sessionName: string;
    cluster: string;
    runs: SessionRunRecord[];
}

// Group runs by session, preserving input order across groups (each session ordered by its most recent run) and within
// each group. Assumes `runs` is already newest-first, as getSessionRuns returns it.
export function groupRunsBySession(runs: SessionRunRecord[]): SessionRunGroup[] {
    const groups: SessionRunGroup[] = [];
    const byId = new Map<string, SessionRunGroup>();
    for (const run of runs) {
        let group = byId.get(run.sessionId);
        if (!group) {
            group = { sessionId: run.sessionId, sessionName: run.sessionName, cluster: run.cluster, runs: [] };
            byId.set(run.sessionId, group);
            groups.push(group);
        }
        group.runs.push(run);
    }
    return groups;
}

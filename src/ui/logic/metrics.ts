export type EffSeverity = 'good' | 'ok' | 'poor' | 'unknown';

/** Efficiency % → a waste severity. Heuristic thresholds: ≥75% good, ≥40% ok, below that wasteful. */
export function efficiencySeverity(pct?: number): EffSeverity {
    if (pct === undefined) { return 'unknown'; }
    if (pct >= 75) { return 'good'; }
    if (pct >= 40) { return 'ok'; }
    return 'poor';
}

const SEVERITY_COLOR: Record<EffSeverity, string> = {
    good: 'var(--vscode-charts-green)',
    ok: 'var(--vscode-charts-yellow)',
    poor: 'var(--vscode-errorForeground)',
    unknown: 'var(--vscode-descriptionForeground)',
};

export function severityColor(sev: EffSeverity): string { return SEVERITY_COLOR[sev]; }

/** Efficiency % as "47%", or "—" when unknown. */
export function fmtPct(pct?: number): string {
    return pct === undefined ? '—' : `${Math.round(pct)}%`;
}

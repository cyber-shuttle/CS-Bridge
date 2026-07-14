export function efficiencyColor(pct?: number): string {
    if (pct === undefined) { return 'var(--vscode-descriptionForeground)'; }
    if (pct >= 75) { return 'var(--vscode-charts-green)'; }
    if (pct >= 40) { return 'var(--vscode-charts-yellow)'; }
    return 'var(--vscode-errorForeground)';
}

/** Efficiency % as "47%", or "—" when unknown. */
export function fmtPct(pct?: number): string {
    return pct === undefined ? '—' : `${Math.round(pct)}%`;
}

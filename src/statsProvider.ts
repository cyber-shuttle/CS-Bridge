import * as vscode from 'vscode';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { StatsState, WebviewMessage } from './models';
import { readAllRuns, clearAllRuns, watchSessionMetrics } from './modules/sessionMetricsStore';
import { getSession } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';

export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    // The watch fires on every live tick too (shared file), so only re-render when the run history actually changed.
    private lastRunsJson = '';

    constructor(extensionUri: vscode.Uri) {
        super(extensionUri);
        watchSessionMetrics(() => {
            const json = JSON.stringify(readAllRuns());
            if (json === this.lastRunsJson) { return; }
            this.lastRunsJson = json;
            void this.pushState();
        });
    }

    protected handleMessage(data: WebviewMessage): void {
        if (data.command === 'ready') { void this.pushState(); return; }
        if (data.command === 'openRunSummary' && data.sessionId) {
            const session = getSession(data.sessionId);
            const run = readAllRuns().find(r => r.sessionId === data.sessionId && r.jobId === data.jobId);
            // Show the run's own recorded snapshot, not the (possibly relaunched) live session's.
            if (session) { openSummaryPanel(this.extensionUri, session, { stats: run?.stats, metrics: run?.metrics }); }
        }
    }

    public async clearHistory(): Promise<void> {
        if (await confirmModal('Clear all recorded run history?', 'Clear')) { clearAllRuns(); }
    }

    public refresh(): void { void this.pushState(); }

    protected pushState(): void {
        const state: StatsState = { runs: readAllRuns() };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

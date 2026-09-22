import * as vscode from 'vscode';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { SessionRunRecord, StatsState, WebviewMessage } from './models';
import { readAllRuns, clearAllRuns, watchSessionMetrics } from './modules/sessionMetricsStore';
import { getSession } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';
import { Control } from './control';

export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    // The watch fires on every live tick too (shared file), so only re-render when the run history actually changed.
    private lastRunsJson = '';

    constructor(extensionUri: vscode.Uri, private readonly control: Control) {
        super(extensionUri);
        control.onDidChange(() => void this.pushState());
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

    // Runs cs-control recorded for the signed-in account join the local history, grouped under their host.
    protected async pushState(): Promise<void> {
        const remote = await this.control.listRuns().catch(() => []);
        const state: StatsState = {
            runs: [...readAllRuns(), ...remote.map(run => ({
                sessionId: run.sessionId, cluster: run.sshHost, jobId: `#${run.seq}`, endedAt: Date.parse(run.endedAt),
                finalStatus: run.finalState.toLowerCase() as SessionRunRecord['finalStatus'], allocation: run.account, queue: run.partition,
                stats: run.stats && { cpuEfficiencyPct: run.stats.cpuEfficiencyPct, memEfficiencyPct: run.stats.memoryEfficiencyPct },
            }))],
        };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

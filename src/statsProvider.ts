import * as vscode from 'vscode';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { StatsState, WebviewMessage } from './models';
import { readAllRuns, clearAllRuns, watchSessionMetrics } from './modules/sessionMetricsStore';
import { getSession } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';
import { errMsg } from './logger';
import { AuthClient } from './control/AuthClient';
import { ControlClient } from './control/ControlClient';

export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    // The watch fires on every live tick too (shared file), so only re-render when the run history actually changed.
    private lastRunsJson = '';

    constructor(extensionUri: vscode.Uri, private readonly auth: AuthClient, private readonly control: ControlClient) {
        super(extensionUri);
        auth.onDidChange(() => void this.pushState());
        watchSessionMetrics(() => {
            const json = JSON.stringify(readAllRuns());
            if (json === this.lastRunsJson) { return; }
            this.lastRunsJson = json;
            void this.pushState();
        });
    }

    protected handleMessage(data: WebviewMessage): void {
        if (data.command === 'ready') { void this.pushState(); return; }
        if (data.command === 'signIn') { void vscode.commands.executeCommand('csbridge.signIn'); return; }
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

    // Local run history is this window's own; the CyberShuttle section is every run cs-control
    // recorded for the account, across machines, and is simply absent while signed out.
    protected async pushState(): Promise<void> {
        const state: StatsState = { runs: readAllRuns(), account: await this.auth.accountName(), controlRuns: [] };
        if (state.account) {
            try { state.controlRuns = await this.control.listRuns(); }
            catch (err) { state.controlError = errMsg(err); }
        }
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

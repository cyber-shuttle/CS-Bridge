import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { StatsState, WebviewMessage } from './models';
import { getSessionRuns, onDidChangeRuns } from './sessionRunSupport';
import { getSession } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';

// Stats view: the resource-utilization history, refreshed when a run finishes.
export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    constructor(extensionUri: vscode.Uri) {
        super(extensionUri);
        onDidChangeRuns(() => void this.pushState());
    }

    protected handleMessage(data: WebviewMessage): void {
        if (data.command === 'ready') { void this.pushState(); return; }
        if (data.command === 'openRunSummary' && data.sessionId) {
            // Open the clicked run's summary in this window, pinned to that run's stored metrics (not the session's latest).
            const session = getSession(data.sessionId);
            const metrics = getSessionRuns().find(r => r.sessionId === data.sessionId && r.jobId === data.jobId)?.metrics;
            if (session) { openSummaryPanel(this.extensionUri, session, metrics); }
        }
    }

    public refresh(): void { void this.pushState(); }

    protected pushState(): void {
        const state: StatsState = { runs: getSessionRuns() };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

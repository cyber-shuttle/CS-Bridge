import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { StatsState, WebviewMessage } from './models';
import { getSessionRuns, watchRuns } from './sessionRunSupport';
import { getSession } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';

export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    constructor(extensionUri: vscode.Uri) {
        super(extensionUri);
        watchRuns(() => void this.pushState());
    }

    protected handleMessage(data: WebviewMessage): void {
        if (data.command === 'ready') { void this.pushState(); return; }
        if (data.command === 'openRunSummary' && data.sessionId) {
            const session = getSession(data.sessionId);
            const pinnedMetrics = getSessionRuns().find(r => r.sessionId === data.sessionId && r.jobId === data.jobId)?.metrics;
            if (session) { openSummaryPanel(this.extensionUri, session, pinnedMetrics); }
        }
    }

    public refresh(): void { void this.pushState(); }

    protected pushState(): void {
        const state: StatsState = { runs: getSessionRuns() };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

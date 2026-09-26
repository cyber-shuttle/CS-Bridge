import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { StatsState, WebviewMessage } from './models';
import type { Control } from './control';
import { watchSessions } from './extensionStore';
import { openSummaryPanel } from './summaryPanel';

export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    constructor(extensionUri: vscode.Uri, private readonly control: Control) {
        super(extensionUri);
        control.onDidChange(() => void this.pushState());
        watchSessions(() => void this.pushState()); // a session record changes when its run ends
    }

    protected handleMessage(data: WebviewMessage): void {
        if (data.command === 'ready') { void this.pushState(); return; }
        if (data.command === 'openRunSummary' && data.sessionId) {
            openSummaryPanel(this.extensionUri, this.control, data.sessionId, data.seq);
        }
    }

    public refresh(): void { void this.pushState(); }

    protected async pushState(): Promise<void> {
        const state: StatsState = { runs: await this.control.listRuns().catch(() => []) };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

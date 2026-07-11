import * as vscode from 'vscode';
import { WebviewProvider } from './webviewProvider';
import { StatsState, WebviewMessage } from './models';
import { getSessionRuns, onDidChangeRuns } from './sessionRunSupport';

// Stats view: the resource-utilization history, refreshed when a run finishes.
export class StatsProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.statsView';
    protected readonly viewKind = 'stats' as const;

    constructor(extensionUri: vscode.Uri) {
        super(extensionUri);
        onDidChangeRuns(() => void this.pushState());
    }

    protected handleMessage(data: WebviewMessage): void {
        if (data.command === 'ready') { void this.pushState(); }
    }

    protected pushState(): void {
        const state: StatsState = { runs: getSessionRuns() };
        this.view?.webview.postMessage({ command: 'state', state });
    }
}

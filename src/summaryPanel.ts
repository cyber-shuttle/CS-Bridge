import * as vscode from 'vscode';
import { getSession, watchSessions } from './extensionStore';
import { getSessionRuns, watchRuns } from './sessionRunSupport';
import { renderHtml } from './webviewProvider';
import { isTerminal } from './modules/sessionMachine';
import { Stats, SlurmSession, SummaryState } from './models';

const PENDING_KEY = 'csbridge.pendingSummaries';
// ponytail: hard cap so a never-consumed baton (e.g. an activation that errors before consuming) can't grow globalState unbounded. Bump if summaries ever legitimately queue deeper than this.
const MAX_PENDING = 8;

// Records "show a summary for <id> after the next local activation". Awaited by the caller so the write flushes before remote.close reloads the window.
export async function enqueuePendingSummary(context: vscode.ExtensionContext, id: string): Promise<void> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []).filter(x => x !== id);
    queue.push(id);
    await context.globalState.update(PENDING_KEY, queue.slice(-MAX_PENDING));
}

export async function consumePendingSummary(context: vscode.ExtensionContext, extensionUri: vscode.Uri): Promise<SlurmSession | undefined> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []);
    if (queue.length === 0) { return undefined; }
    const [id, ...rest] = queue;
    await context.globalState.update(PENDING_KEY, rest);
    const session = getSession(id);
    if (session) { openSummaryPanel(extensionUri, session); }
    return session;
}

export function openSummaryPanel(extensionUri: vscode.Uri, session: SlurmSession, statsOverride?: Stats): void {
    const panel = vscode.window.createWebviewPanel(
        'csbridge.summary', `Session ${session.name} summary: `,
        vscode.ViewColumn.One, { enableScripts: true },
    );
    // Re-read the session each post: it may still be 'stopping' at open and flip to 'stopped' while the tab is up.
    const post = () => {
        const s = getSession(session.id) ?? session;
        const run = getSessionRuns().find(r => r.cluster === s.cluster && r.jobId === s.jobId);
        // Terminal session with no run record yet → recordSessionRun is still in flight; the webview keeps its spinner
        // rather than flashing "no stats". A stats-opened summary passes statsOverride, so it's never pending.
        const metricsPending = statsOverride === undefined && isTerminal(s.status) && !run;
        const state: SummaryState = { session: s, stats: statsOverride ?? run?.stats, metricsPending };
        void panel.webview.postMessage({ command: 'state', state });
    };
    const msgSub = panel.webview.onDidReceiveMessage((m: { command?: string }) => { if (m?.command === 'ready') { post(); } });
    const runsSub = watchRuns(() => post());
    const sessSub = watchSessions(() => post());
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'summary');
    panel.onDidDispose(() => { msgSub.dispose(); runsSub.close(); sessSub.close(); });
}

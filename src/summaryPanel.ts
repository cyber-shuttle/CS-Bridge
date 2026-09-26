import * as vscode from 'vscode';
import { getSession } from './extensionStore';
import { renderHtml } from './webviewProvider';
import { SlurmSession, SummaryState } from './models';
import { Control, runView, toMetrics } from './control';

const PENDING_KEY = 'csbridge.pendingSummaries';
// Trade-off: hard cap so a never-consumed baton (e.g. an activation that errors before consuming) can't grow globalState unbounded. Bump if summaries ever legitimately queue deeper than this.
const MAX_PENDING = 8;

// Records "show a summary for <id> after the next local activation". Awaited by the caller so the write flushes before remote.close reloads the window.
export async function enqueuePendingSummary(context: vscode.ExtensionContext, id: string): Promise<void> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []).filter(x => x !== id);
    queue.push(id);
    await context.globalState.update(PENDING_KEY, queue.slice(-MAX_PENDING));
}

export async function consumePendingSummary(context: vscode.ExtensionContext, control: Control): Promise<SlurmSession | undefined> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []);
    if (queue.length === 0) { return undefined; }
    const [id, ...rest] = queue;
    await context.globalState.update(PENDING_KEY, rest);
    const session = getSession(id);
    if (session?.planeId) { openSummaryPanel(context.extensionUri, control, session.planeId, undefined, session.submittedAt); }
    return session;
}

// A handed-off summary names no seq, so `since` skips earlier runs of a session started again.
export function openSummaryPanel(extensionUri: vscode.Uri, control: Control, sessionId: string, seq?: number, since = 0): void {
    const panel = vscode.window.createWebviewPanel(
        'csbridge.summary', `Session ${sessionId} summary`,
        vscode.ViewColumn.One, { enableScripts: true },
    );
    let complete = false; // a found run is frozen, and cs-plane gathers no stats for a client's run
    const post = async () => {
        const run = (await control.listRuns().catch(() => [])).find(r => r.sessionId === sessionId && (seq === undefined || r.seq === seq) && Date.parse(r.endedAt) >= since);
        if (!run) { return; }
        complete = true;
        const state: SummaryState = { session: runView(run), metrics: toMetrics(run.samples), stats: run.stats };
        void panel.webview.postMessage({ command: 'state', state });
    };
    const msgSub = panel.webview.onDidReceiveMessage((m: { command?: string }) => { if (m?.command === 'ready') { void post(); } });
    const timer = setInterval(() => { if (!complete) { void post(); } }, 15_000);
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'summary');
    panel.onDidDispose(() => { msgSub.dispose(); clearInterval(timer); });
}

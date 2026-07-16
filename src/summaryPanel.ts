import * as vscode from 'vscode';
import { getSession, watchSessions } from './extensionStore';
import { getSessionRuns, watchRuns } from './sessionRunSupport';
import { renderHtml } from './webviewProvider';
import { readSessionMetrics, readSessionStats, watchSessionMetrics } from './modules/sessionMetricsStore';
import { Metric, Stats, SlurmSession, SummaryState } from './models';

// A finished run's fixed snapshot (from the Stats view), shown instead of the possibly-relaunched live session.
interface RunSnapshot { stats?: Stats; metrics?: Metric[] }

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

export function openSummaryPanel(extensionUri: vscode.Uri, session: SlurmSession, runSnapshot?: RunSnapshot): void {
    const panel = vscode.window.createWebviewPanel(
        'csbridge.summary', `Session ${session.name} summary: `,
        vscode.ViewColumn.One, { enableScripts: true },
    );
    // Re-read the session each post: it may still be 'stopping' at open and flip to 'stopped' while the tab is up.
    const post = () => {
        const s = getSession(session.id) ?? session;
        // Past run from Stats: its fixed snapshot. Live: current samples + latest sacct copy (run record or in-run file).
        const run = runSnapshot ? undefined : getSessionRuns().find(r => r.cluster === s.cluster && r.jobId === s.jobId);
        const metrics = runSnapshot ? runSnapshot.metrics : readSessionMetrics(s.id);
        const stats = runSnapshot ? runSnapshot.stats : (run?.stats ?? readSessionStats(s.id));
        const state: SummaryState = { session: s, metrics, stats };
        void panel.webview.postMessage({ command: 'state', state });
    };
    const msgSub = panel.webview.onDidReceiveMessage((m: { command?: string }) => { if (m?.command === 'ready') { post(); } });
    const runsSub = watchRuns(() => post());
    const sessSub = watchSessions(() => post());
    const metricsSub = watchSessionMetrics(() => post()); // live view: refresh sparklines as samples land
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'summary');
    panel.onDidDispose(() => { msgSub.dispose(); runsSub.close(); sessSub.close(); metricsSub.close(); });
}

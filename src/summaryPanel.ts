import * as vscode from 'vscode';
import { getSession } from './extensionStore';
import { renderHtml } from './webviewProvider';
import { SlurmSession } from './models';

const PENDING_KEY = 'csbridge.pendingSummaries';
// ponytail: hard cap so a never-consumed baton (e.g. an activation that errors before consuming) can't grow globalState unbounded. Bump if summaries ever legitimately queue deeper than this.
const MAX_PENDING = 8;

// Records "show a summary for <id> after the next local activation". Awaited by the caller so the write flushes before remote.close reloads the window.
export async function enqueuePendingSummary(context: vscode.ExtensionContext, id: string): Promise<void> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []).filter(x => x !== id);
    queue.push(id);
    await context.globalState.update(PENDING_KEY, queue.slice(-MAX_PENDING));
}

// On a local window's activation: if a summary is queued, shift one and open its tab. No-op otherwise.
export async function consumePendingSummary(context: vscode.ExtensionContext, extensionUri: vscode.Uri): Promise<void> {
    const queue = context.globalState.get<string[]>(PENDING_KEY, []);
    if (queue.length === 0) { return; }
    const [id, ...rest] = queue;
    await context.globalState.update(PENDING_KEY, rest);
    const session = getSession(id);
    if (session) { openSummaryPanel(extensionUri, session); }
}

// Opens the summary as an editor tab. The webview posts `ready` on mount (useWebviewState); we reply with the record it renders.
export function openSummaryPanel(extensionUri: vscode.Uri, session: SlurmSession): void {
    const panel = vscode.window.createWebviewPanel(
        'csbridge.summary', `Session Summary — ${session.name}`,
        vscode.ViewColumn.One, { enableScripts: true },
    );
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'summary');
    const sub = panel.webview.onDidReceiveMessage((m: { command?: string }) => {
        if (m?.command === 'ready') { void panel.webview.postMessage({ command: 'state', state: session }); }
    });
    panel.onDidDispose(() => sub.dispose());
}

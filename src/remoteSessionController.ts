import * as vscode from 'vscode';
import { getSession, watchSessions } from './extensionStore';
import { isTerminal, isWallTimeExpired } from './modules/sessionMachine';
import { remainingMs, fmtTime, wallMs } from './ui/logic/session';
import { enqueuePendingSummary } from './summaryPanel';

const WARN_THRESHOLD_MS = 10 * 60_000; // color the status bar under 10 minutes left

// Lives only in a cshost remote window. Owns the wall-time status bar and the graceful end:
// on wall-time expiry or any terminal status, disconnect the window to local and queue its summary.
export class RemoteSessionController implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly ticker: ReturnType<typeof setInterval>;
    private readonly watcher: vscode.Disposable;
    private torndown = false;

    constructor(private readonly context: vscode.ExtensionContext, private readonly sessionId: string) {
        this.item = vscode.window.createStatusBarItem('csbridge.walltime', vscode.StatusBarAlignment.Left, 1000);
        this.item.command = 'csbridge.sessionsView.focus';
        this.render();
        if (!this.torndown) { this.item.show(); }

        this.ticker = setInterval(() => this.render(), 1000);
        // Keeps the in-memory record fresh (merge happens in the watch callback) and catches terminal transitions.
        const w = watchSessions(() => this.render());
        this.watcher = { dispose: () => w.close() };
    }

    // Refresh the countdown, and fire the graceful end the moment the session is expired or terminal.
    private render(): void {
        const s = getSession(this.sessionId);
        if (!s) { return; }
        if (isWallTimeExpired(s, Date.now()) || isTerminal(s.status)) { void this.teardown(); return; }

        const total = wallMs(s.wallTime);
        if (total <= 0) {
            this.item.text = '$(clock) no limit';
            this.item.tooltip = `${s.name} · ${s.cluster}`;
            this.item.backgroundColor = undefined;
            return;
        }
        const left = remainingMs(s, Date.now());
        const endsAt = new Date((s.startedAt ?? Date.now()) + total).toLocaleTimeString();
        this.item.text = `$(clock) ${fmtTime(left)} left`;
        this.item.tooltip = `${s.name} · ${s.cluster} · ends ${endsAt}`;
        this.item.backgroundColor = left <= WARN_THRESHOLD_MS
            ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    }

    // Enqueue the summary, then convert the window to local (which reloads it). Idempotent.
    private async teardown(): Promise<void> {
        if (this.torndown) { return; }
        this.torndown = true;
        clearInterval(this.ticker);
        this.item.hide();
        await enqueuePendingSummary(this.context, this.sessionId);
        // remote.close reuses this window with remoteAuthority:null → local reload. If unavailable, fall back to closing.
        try { await vscode.commands.executeCommand('workbench.action.remote.close'); }
        catch { void vscode.commands.executeCommand('workbench.action.closeWindow'); }
    }

    dispose(): void {
        clearInterval(this.ticker);
        this.watcher.dispose();
        this.item.dispose();
    }
}

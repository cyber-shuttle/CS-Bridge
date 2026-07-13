import * as vscode from 'vscode';
import { getSession, updateSession, watchSessions } from './extensionStore';
import { isTerminal, isWallTimeExpired } from './modules/sessionMachine';
import { remainingMs, fmtTime, wallMs } from './ui/logic/session';
import { enqueuePendingSummary } from './summaryPanel';

const WARN_THRESHOLD_MS = 10 * 60_000; // color the status bar under 10 minutes left

// Lives only in a cshost remote window. Owns the wall-time status bar + a Stop button, and the end-to-local:
// on wall-time expiry, terminal status, or the user hitting Stop, queue the summary and convert this window to local.
export class RemoteSessionController implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly stopItem: vscode.StatusBarItem;
    private readonly stopCommand: vscode.Disposable;
    private readonly ticker: ReturnType<typeof setInterval>;
    private readonly watcher: vscode.Disposable;
    private torndown = false;

    constructor(private readonly context: vscode.ExtensionContext, private readonly sessionId: string) {
        this.item = vscode.window.createStatusBarItem('csbridge.walltime', vscode.StatusBarAlignment.Left, 1000);
        this.item.command = 'csbridge.sessionsView.focus';

        this.stopItem = vscode.window.createStatusBarItem('csbridge.stopSession', vscode.StatusBarAlignment.Left, 999);
        this.stopItem.text = '$(debug-stop) Stop';
        this.stopItem.tooltip = 'Stop this session and return to a local window';
        this.stopItem.command = 'csbridge.stopRemoteSession';
        this.stopCommand = vscode.commands.registerCommand('csbridge.stopRemoteSession', () => this.stopAndSummarize());

        this.render();
        if (!this.torndown) { this.item.show(); this.stopItem.show(); }

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

    // Graceful end on wall-time expiry / terminal status. Idempotent.
    private async teardown(): Promise<void> {
        if (this.torndown) { return; }
        this.torndown = true;
        await this.endToLocal();
    }

    // User hit Stop: mark the session stopping and reload to local, which finishes the stop + shows the summary.
    private async stopAndSummarize(): Promise<void> {
        if (this.torndown) { return; }
        const session = getSession(this.sessionId);
        if (!session) { return; }
        const choice = await vscode.window.showWarningMessage(
            'Stop session?', { modal: true, detail: 'This stops the running job and returns this window to local.' }, 'Stop');
        if (choice !== 'Stop' || this.torndown) { return; } // may have torn down (wall-time/terminal) during the dialog

        this.torndown = true; // claim now so the 1s render tick can't race the reload
        this.stopItem.text = '$(loading~spin) Stopping…';
        // Hand the stop to the local window: mark 'stopping' and reload now, so the summary comes up immediately in its
        // stopping state. reattachLiveSessions there runs the scancel + metrics record — off this window's critical path,
        // which is moot anyway since remote.close is about to tear this window down.
        session.status = 'stopping';
        session.errorMessage = '';
        updateSession(session);
        await this.endToLocal();
    }

    // Enqueue the summary, then convert the window to local (which reloads it). Caller has claimed `torndown`.
    private async endToLocal(): Promise<void> {
        clearInterval(this.ticker);
        this.item.hide();
        this.stopItem.hide();
        await enqueuePendingSummary(this.context, this.sessionId);
        // remote.close reuses this window with remoteAuthority:null → local reload. If unavailable, fall back to closing.
        try { await vscode.commands.executeCommand('workbench.action.remote.close'); }
        catch { void vscode.commands.executeCommand('workbench.action.closeWindow'); }
    }

    dispose(): void {
        clearInterval(this.ticker);
        this.watcher.dispose();
        this.item.dispose();
        this.stopItem.dispose();
        this.stopCommand.dispose();
    }
}

import * as vscode from 'vscode';
import { Logger } from './logger';
import { initSessionStore, mutateWindowPids, getAllSessions } from './extensionStore';
import { csHostAlias } from './modules/sshHostsStore';
import { isPidAlive } from './modules/fsSupport';
import { SessionProvider } from './sessionProvider';
import { SshHostProvider } from './sshHostProvider';
import { StatsProvider } from './statsProvider';
import { SshManager } from './modules/sshSupport';
import { RemoteSessionController } from './remoteSessionController';
import { consumePendingSummary } from './summaryPanel';

export async function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('CS Bridge extension activating');

    logger.info(`Initializing session store...`);
    const sessionStoreLocation = initSessionStore();
    logger.info(`Session store initialized to ${sessionStoreLocation}`);

    const id = currentWindowSessionId();
    if (id) {
        logger.info(`Window is connected to CS Bridge session ${id}; pid=${process.pid}`);
        try { mutateWindowPids(id, pids => [...new Set([...pids.filter(isPidAlive), process.pid])]); }
        catch (err) { logger.error(`Failed to register windowPid for session ${id}`, err); }
        context.subscriptions.push({
            dispose: () => {
                try { mutateWindowPids(id, pids => pids.filter(p => p !== process.pid)); }
                catch (err) { logger.error(`Failed to unregister windowPid for session ${id}`, err); }
            },
        });
    }

    // The SSH Hosts pane is hidden in read-only remote (cshost) windows.
    void vscode.commands.executeCommand('setContext', 'csbridge.remote', !!id);

    SshManager.initInstance(context.extensionUri);
    const sessionProvider = new SessionProvider(context.extensionUri, id);
    const sshHostProvider = new SshHostProvider(context.extensionUri);
    const statsProvider = new StatsProvider(context.extensionUri);
    context.subscriptions.push(
        sessionProvider,
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider),
        vscode.window.registerWebviewViewProvider(SshHostProvider.viewType, sshHostProvider),
        vscode.window.registerWebviewViewProvider(StatsProvider.viewType, statsProvider),
        vscode.commands.registerCommand('csbridge.newSession', () => sessionProvider.startNewSession()),
        vscode.commands.registerCommand('csbridge.switchAccount', () => sessionProvider.switchAccount()),
        vscode.commands.registerCommand('csbridge.addHost', () => sshHostProvider.addSshHost()),
        vscode.commands.registerCommand('csbridge.refreshHosts', () => sshHostProvider.refreshSshHosts()),
        vscode.commands.registerCommand('csbridge.refreshStats', () => statsProvider.refresh()),
        vscode.commands.registerCommand('csbridge.clearRunHistory', () => statsProvider.clearHistory()),
        vscode.commands.registerCommand('csbridge.newSessionOnHost', (host: string) => sessionProvider.startSessionDraft(host)),
    );

    void sessionProvider.reattachLiveSessions();

    if (id) {
        // Remote (cshost) window: own the wall-time status bar + graceful end for this session.
        context.subscriptions.push(new RemoteSessionController(context, id));
    }
    else {
        void consumePendingSummary(context, context.extensionUri).then((session) => {
            if (session?.status === 'stopping') { sessionProvider.finishInterruptedStop(session); }
        });
    }

    // on first-time install, show a toast with an "Open" action to reveal the sidebar panel.
    const marker = vscode.Uri.joinPath(context.globalStorageUri, 'opened.marker');
    if (!(await vscode.workspace.fs.stat(marker).then(() => true, () => false))) {
        await vscode.workspace.fs.writeFile(marker, new Uint8Array());
        void vscode.window.showInformationMessage('Completed installing CS Bridge.', 'Open')
            .then(c => c === 'Open' && vscode.commands.executeCommand('csbridge.sessionsView.focus'));
    }

    logger.info('CS Bridge extension activated');
}

function currentWindowSessionId(): string | undefined {
    const auth = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '';
    const prefix = 'ssh-remote+';
    if (!auth.startsWith(prefix)) { return undefined; }
    const suffix = auth.slice(prefix.length);
    if (suffix.startsWith('cshost-')) { return suffix.slice('cshost-'.length); } // legacy: alias was the session id
    // The alias carries no id, so reconstruct each session's and match. Safe here: extensionKind:ui runs this window's
    // extension host locally, so it can read the local session store (already initialized above).
    return getAllSessions().find(s => csHostAlias(s.cluster, s.name) === suffix)?.id;
}

export function deactivate() {
    SshManager.disposeInstance();
    Logger.getInstance().dispose();
}

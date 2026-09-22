import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { initSessionStore, mutateWindowPids, getAllSessions } from './extensionStore';
import { csHostAlias } from './modules/sshHostsStore';
import { isPidAlive } from './modules/fsSupport';
import { SessionProvider } from './sessionProvider';
import { SshHostProvider } from './sshHostProvider';
import { StatsProvider } from './statsProvider';
import { SshManager } from './modules/sshSupport';
import { AuthClient } from './control/AuthClient';
import { ControlClient } from './control/ControlClient';
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

    const isRemoteWindow = !!id;
    void vscode.commands.executeCommand('setContext', 'csbridge.remote', isRemoteWindow);

    SshManager.initInstance(context.extensionUri);
    const auth = new AuthClient({
        secrets: context.secrets,
        baseUrl: () => vscode.workspace.getConfiguration('csbridge').get<string>('controlUrl', ''),
    });
    const control = new ControlClient(auth);
    const sessionProvider = new SessionProvider(context.extensionUri, id);
    const sshHostProvider = new SshHostProvider(context.extensionUri, auth, control);
    const statsProvider = new StatsProvider(context.extensionUri, auth, control);
    context.subscriptions.push(
        sessionProvider,
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider),
        vscode.window.registerWebviewViewProvider(SshHostProvider.viewType, sshHostProvider),
        vscode.window.registerWebviewViewProvider(StatsProvider.viewType, statsProvider),
        vscode.commands.registerCommand('csbridge.newSession', () => sessionProvider.startNewSession()),
        vscode.commands.registerCommand('csbridge.switchAccount', () => sessionProvider.switchAccount()),
        vscode.commands.registerCommand('csbridge.addHost', () => sshHostProvider.addSshHost()),
        vscode.commands.registerCommand('csbridge.refreshHosts', () => sshHostProvider.refresh()),
        vscode.commands.registerCommand('csbridge.refreshStats', () => statsProvider.refresh()),
        vscode.commands.registerCommand('csbridge.clearRunHistory', () => statsProvider.clearHistory()),
        vscode.commands.registerCommand('csbridge.newSessionOnHost', (host: string) => sessionProvider.startSessionDraft(host)),
        vscode.commands.registerCommand('csbridge.signIn', () => signIn(auth)),
        vscode.commands.registerCommand('csbridge.signOut', () => auth.signOut()),
    );

    void sessionProvider.reattachLiveSessions();

    if (id) {
        // Remote window: own the wall-time status bar + graceful end for this session.
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

// The device grant's user-facing half: show the code, send the user to the issuer, then wait. Cancelling
// the progress notification abandons the wait; the code simply expires at the issuer.
async function signIn(auth: AuthClient): Promise<void> {
    try {
        const authorization = await auth.startSignIn();
        const open = await vscode.window.showInformationMessage(
            `Approve the code ${authorization.userCode} in your browser to finish signing in to CyberShuttle.`,
            { modal: true }, 'Open browser',
        );
        if (!open) { return; }
        await vscode.env.openExternal(vscode.Uri.parse(authorization.verificationUriComplete));
        const signedIn = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Waiting for CyberShuttle sign-in with code ${authorization.userCode}`, cancellable: true },
            (_progress, token) => auth.awaitSignIn(authorization, () => token.isCancellationRequested),
        );
        if (signedIn) { void vscode.window.showInformationMessage(`Signed in to CyberShuttle as ${await auth.accountName()}.`); }
    }
    catch (err) { vscode.window.showErrorMessage(`CyberShuttle sign-in failed: ${errMsg(err)}`); }
}

function currentWindowSessionId(): string | undefined {
    const auth = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '';
    const prefix = 'ssh-remote+';
    if (!auth.startsWith(prefix)) { return undefined; }
    const suffix = auth.slice(prefix.length);
    // The alias carries no id, so reconstruct each session's and match. Safe here: extensionKind:ui runs this window's
    // extension host locally, so it can read the local session store (already initialized above).
    return getAllSessions().find(s => csHostAlias(s.cluster, s.name) === suffix)?.id;
}

export function deactivate() {
    SshManager.disposeInstance();
    Logger.getInstance().dispose();
}

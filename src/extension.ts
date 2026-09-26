import * as vscode from 'vscode';
import { Logger, errMsg } from './logger';
import { initSessionStore, getAllSessions } from './extensionStore';
import { csHostAlias } from './modules/sshHostsStore';
import { Control } from './control';
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
    const isRemoteWindow = !!id;
    void vscode.commands.executeCommand('setContext', 'csbridge.remote', isRemoteWindow);

    SshManager.initInstance(context.extensionUri);
    const control = new Control(context.secrets);
    const sessionProvider = new SessionProvider(context.extensionUri, control, id);
    const sshHostProvider = new SshHostProvider(context.extensionUri);
    const statsProvider = new StatsProvider(context.extensionUri, control);
    context.subscriptions.push(
        sessionProvider,
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider),
        vscode.window.registerWebviewViewProvider(SshHostProvider.viewType, sshHostProvider),
        vscode.window.registerWebviewViewProvider(StatsProvider.viewType, statsProvider),
        vscode.commands.registerCommand('csbridge.newSession', () => sessionProvider.startNewSession()),
        vscode.commands.registerCommand('csbridge.addHost', () => sshHostProvider.addSshHost()),
        vscode.commands.registerCommand('csbridge.refreshHosts', () => sshHostProvider.refreshSshHosts()),
        vscode.commands.registerCommand('csbridge.refreshStats', () => statsProvider.refresh()),
        vscode.commands.registerCommand('csbridge.signIn', () => signIn(control)),
        vscode.commands.registerCommand('csbridge.signOut', () => control.signOut()),
    );

    if (id) {
        // Remote window: own the wall-time status bar + graceful end for this session.
        context.subscriptions.push(new RemoteSessionController(context, id));
    }
    else {
        void consumePendingSummary(context, control).then((session) => {
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
    // The alias carries no id, so reconstruct each session's and match. Safe here: extensionKind:ui runs this window's
    // extension host locally, so it can read the local session store (already initialized above).
    return getAllSessions().find(s => csHostAlias(s.cluster, s.planeId ?? '') === suffix)?.id;
}

async function signIn(control: Control): Promise<void> {
    try {
        const code = await control.startSignIn();
        const open = await vscode.window.showInformationMessage(`Approve the code ${code.userCode} in your browser to sign in to CyberShuttle.`, { modal: true }, 'Open browser');
        if (!open) { return; }
        await vscode.env.openExternal(vscode.Uri.parse(code.verificationUriComplete));
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Waiting for CyberShuttle sign-in with code ${code.userCode}`, cancellable: true },
            (_progress, token) => control.awaitSignIn(code, () => token.isCancellationRequested),
        );
    }
    catch (err) { vscode.window.showErrorMessage(`CyberShuttle sign-in failed: ${errMsg(err)}`); }
}

export function deactivate() {
    SshManager.disposeInstance();
    Logger.getInstance().dispose();
}

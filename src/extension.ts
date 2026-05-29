import * as vscode from 'vscode';
import { Logger } from './logger';
import { initSessionStore, mutateWindowPids } from './extensionStore';
import { isPidAlive } from './modules/fsSupport';
import { SessionProvider } from './sessionProvider';
import { SshManager } from './modules/sshSupport';


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
            }
        });
    }

    SshManager.initInstance(context.extensionUri);
    const sessionProvider = new SessionProvider(context.extensionUri, id);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider));

    // on first-time install, show a toast with an "Open" action to reveal the sidebar panel.
    const marker = vscode.Uri.joinPath(context.globalStorageUri, 'opened.marker');
    if (!(await vscode.workspace.fs.stat(marker).then(() => true, () => false))) {
        await vscode.workspace.fs.writeFile(marker, new Uint8Array());
        void vscode.window.showInformationMessage('Completed installing CS Bridge.', 'Open')
            .then(c => c === 'Open' && vscode.commands.executeCommand(`${SessionProvider.viewType}.focus`));
    }

    logger.info('CS Bridge extension activated');
}

function currentWindowSessionId(): string | undefined {
    const auth = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '';
    const prefix = 'ssh-remote+cshost-';
    return auth.startsWith(prefix) ? auth.slice(prefix.length) : undefined;
}

export function deactivate() {
    Logger.getInstance().dispose();
}

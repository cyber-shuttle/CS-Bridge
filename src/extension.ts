import * as vscode from 'vscode';
import { Logger } from './logger';
import { initSessionStore, patchSession } from './extensionStore';
import { SessionProvider } from './sessionProvider';
import { SshManager } from './modules/sshSupport';


export async function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('CyberShuttle extension activating');

    logger.info(`Initializing session store...`);
    const sessionStoreLocation = initSessionStore();
    logger.info(`Session store initialized to ${sessionStoreLocation}`);

    const id = currentWindowSessionId();
    if (id) {
        logger.info(`Window is connected to CyberShuttle session ${id}; pid=${process.pid}`);
        patchSession(id, { windowPid: process.pid });
        context.subscriptions.push({ dispose: () => patchSession(id, { windowPid: undefined }) });
    }

    SshManager.initInstance(context.extensionUri);
    const sessionProvider = new SessionProvider(context.extensionUri, id);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider));

    logger.info('CyberShuttle extension activated');
}

function currentWindowSessionId(): string | undefined {
    const auth = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? '';
    const prefix = 'ssh-remote+cshost-';
    return auth.startsWith(prefix) ? auth.slice(prefix.length) : undefined;
}

export function deactivate() {
    Logger.getInstance().dispose();
}

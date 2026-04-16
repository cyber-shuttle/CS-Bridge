import * as vscode from 'vscode';
import { Logger } from './logger';
import { initSessionStore } from './extensionStore';
import { SessionProvider } from './sessionProvider';
import { SshManager } from './modules/sshSupport';


export async function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('CyberShuttle extension activating');

    logger.info(`Initializing session store...`);
    const sessionStoreLocation = await initSessionStore();
    logger.info(`Session store initialized to ${sessionStoreLocation}`);

    SshManager.initInstance(context.extensionUri);
    const sessionProvider = new SessionProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider));

    logger.info('CyberShuttle extension activated');
}

export function deactivate() {
    Logger.getInstance().dispose();
}

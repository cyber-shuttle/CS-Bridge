import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Logger } from './logger';
import { initSessionStore } from './extensionStore';
import { SessionProvider } from './sessionProvider';
import { SshManager } from './modules/sshSupport';


export async function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('CyberShuttle extension activating');

    const storagePath = path.join(os.homedir(), '.cybershuttle');
    await fs.mkdir(storagePath, { recursive: true });
    await initSessionStore(storagePath);

    SshManager.initInstance(context.extensionUri);
    const sessionProvider = new SessionProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider));

    logger.info('CyberShuttle extension activated');
}

export function deactivate() {
    Logger.getInstance().dispose();
}

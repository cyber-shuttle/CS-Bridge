import * as vscode from 'vscode';
import { Logger } from './logger';
import { SessionProvider } from './sessionProvider';


export async function activate(context: vscode.ExtensionContext) {
    const logger = Logger.getInstance();
    logger.info('CyberShuttle extension activating');

    const sessionProvider = new SessionProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SessionProvider.viewType, sessionProvider));

    logger.info('CyberShuttle extension activated');
}

export function deactivate() {
    Logger.getInstance().dispose();
}

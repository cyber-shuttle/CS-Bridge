import * as vscode from 'vscode';
import { Logger } from './logger';
import { initSessionStore } from './extensionStore';
import { SessionProvider } from './sessionProvider';
import { SshManager } from './modules/sshSupport';
import { UsageTreeProvider } from './usageTreeProvider';
import { UsageDetailsProvider } from './usageDetailsProvider';


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

    const usageProvider = new UsageTreeProvider();
    const detailProvider = new UsageDetailsProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(UsageTreeProvider.viewType, usageProvider),
        vscode.workspace.registerTextDocumentContentProvider(UsageDetailsProvider.scheme, detailProvider),
        vscode.commands.registerCommand('cybershuttle.usage.openJob', async (arg: { cluster: string; jobId: string }) => {
            const uri = vscode.Uri.parse(`${UsageDetailsProvider.scheme}:${arg.cluster}/${arg.jobId}.md`);
            detailProvider.refresh(uri);
            await vscode.commands.executeCommand('markdown.showPreview', uri);
        }),
    );

    logger.info('CyberShuttle extension activated');
}

export function deactivate() {
    Logger.getInstance().dispose();
}

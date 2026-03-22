import { SlurmSession } from "../models";
import * as vscode from 'vscode';
import { Logger } from './../logger';
import { updateSession } from "../extensionStore";

export async function launchSessionWithProgress(session: SlurmSession, webView: vscode.Webview) {

    const logger = Logger.getInstance();
    logger.info(`Initiating launch for session: ${session.name}`);
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Launching session ${session.name}...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            logger.info(`Session launch cancelled: ${session.name}`);
            session.status = 'cancelled';
            updateSession(session);
            webView.postMessage({ command: 'sessionUpdate', session: session });
        });

        progress.report({ message: "Starting..." });

        // Implement linkspan installation
        // Implement sbatch job submission
        // Implement reading job status from Slurm and updating session status accordingly

        for (let i = 0; i < 100; i += 2) {
            logger.info(`Launching session ${session.name}: Step ${i / 20 + 1} of 5`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            progress.report({ increment: 20, message: `Step ${i / 20 + 1} of 5` });
            if (token.isCancellationRequested) {
                logger.info(`Session launch cancelled during progress: ${session.name}`);
                // session.status = 'cancelled';
                // updateSession(session);
                //webView.postMessage({ command: 'sessionUpdate', session: session });
                return;
            }
        }

    });

}
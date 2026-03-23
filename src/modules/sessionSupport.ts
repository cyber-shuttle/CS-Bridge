import { SlurmSession } from "../models";
import * as vscode from 'vscode';
import { Logger } from './../logger';
import { updateSession } from "../extensionStore";
import { SshManager } from "./sshSupport";

const logger = Logger.getInstance();

async function checkSlurmAvailability(session: SlurmSession, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    try {
        progress.report({ message: "Checking Slurm availability on cluster" });
        const sshManager = SshManager.getInstance();
        const slurmResponse = await sshManager.runRemoteCommand(session.cluster, 'sinfo');
        if (slurmResponse.code === 0) {
            logger.info(`Slurm is available on cluster ${session.cluster}`);
            return true;
        } else {
            const errorMessage = `Failed to check Slurm availability on cluster ${session.cluster}. Error: ${slurmResponse.stderr}`;
            logger.error(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
            progress.report({ message: errorMessage });
            session.status = 'failed';
            session.errorMessage = errorMessage;
            updateSession(session);
            return false;
        }
    } catch (error: any) {
        const errorMessage = `Error launching session on cluster ${session.cluster}: ${error.message || error}`;
        logger.error(errorMessage, error);
        vscode.window.showErrorMessage(errorMessage);
        progress.report({ message: errorMessage });
        session.status = 'failed';
        session.errorMessage = errorMessage;
        updateSession(session);
        return false;
    }
}

async function checkLinkspanInstallation(session: SlurmSession, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    const sshManager = SshManager.getInstance();

    progress.report({ message: "Checking Linkspan installation on cluster" });
    const remoteVersionResult = await sshManager.runRemoteCommand(session.cluster, `curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | grep -oP '[^/]+$'`);
    //logger.info('Remote version check output:', remoteVersion.stdout);
    const localVersionResult = await sshManager.runRemoteCommand(session.cluster, `~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo ""`);
    //logger.info('Local version check output:', localVersion.stdout);

    if (remoteVersionResult.code !== 0) {
        const errorMessage = `Failed to check Linkspan latest version. Error: ${remoteVersionResult.stderr}`;
        logger.error(errorMessage);
        return false;
    }
    if (localVersionResult.code !== 0) {
        const errorMessage = `Failed to check Linkspan version on cluster ${session.cluster}. Error ${localVersionResult.stderr}`;
        logger.error(errorMessage);
        return false;
    }

    const localVersion = localVersionResult.stdout.trim();
    // Remove leading 'v' if present in remote version tag
    const remoteVersion = remoteVersionResult.stdout.trim().startsWith('v') ? remoteVersionResult.stdout.trim().substring(1) : remoteVersionResult.stdout.trim();


    if (localVersion !== '' && remoteVersion !== '' && localVersion === remoteVersion) {
        logger.info(`Linkspan is already installed and up to date on cluster ${session.cluster}`);
        return true;
    } else {
        logger.info(`Linkspan is not installed or outdated on cluster ${session.cluster}. Local version: ${localVersion}, Latest version: ${remoteVersion}`);
        return false;
    }
}

async function installLinkspan(session: SlurmSession, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    try {
        progress.report({ message: "Installing Linkspan on cluster" });
        const sshManager = SshManager.getInstance();
        const archResult = await sshManager.runRemoteCommand(session.cluster, 'uname -m');
        if (archResult.code !== 0) {
            throw new Error('Failed to detect remote architecture');
        }
        let arch = archResult.stdout.trim();
        if (arch === 'aarch64') { arch = 'arm64'; }

        logger.info(`Detected architecture on cluster ${session.cluster}: ${arch}`);

        const assetName = `linkspan_Linux_${arch}.tar.gz`;
        const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;
        logger.info(`Downloading Linkspan from ${downloadUrl} for architecture ${arch}`);

        const installResult = await sshManager.runRemoteCommand(session.cluster,
            `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`);
        if (installResult.code === 0) {
            logger.info(`Linkspan installed successfully on cluster ${session.cluster}`);
            logger.info('Installation output:', installResult.stdout);
            return true;
        } else {
            throw new Error(`Error: ${installResult.stderr}`);
        }

    } catch (error: any) {
        const errorMessage = `Error installing Linkspan on cluster ${session.cluster}: ${error.message || error}`;
        logger.error(errorMessage, error);
        vscode.window.showErrorMessage(errorMessage);
        progress.report({ message: errorMessage });
        session.status = 'failed';
        session.errorMessage = errorMessage;
        updateSession(session);
        return false;
    }
}

export async function launchSessionWithProgress(session: SlurmSession, webView: vscode.Webview) {

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

        // Check Slurm availability on the cluster before proceeding
        const slurmAvailable = await checkSlurmAvailability(session, progress);
        if (!slurmAvailable) {
            return;
        }

        const linkspanInstalled = await checkLinkspanInstallation(session, progress);
        if (!linkspanInstalled) {
            const installMessage = `Linkspan is not installed on cluster ${session.cluster}. Installing Linkspan...`;
            logger.info(installMessage);
            progress.report({ message: installMessage });
            const installSuccess = await installLinkspan(session, progress);
            if (!installSuccess) {
                return;
            }
        }


        /*for (let i = 0; i < 100; i += 2) {
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
        }*/

    });

}
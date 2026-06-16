import { SlurmJobStatus, SlurmSession } from "../models";
import * as vscode from 'vscode';
import { Logger } from './../logger';
import { updateSession } from "../extensionStore";
import { SshManager } from "./sshSupport";
import { getSlurmJobOutput, getSlurmJobStatus } from "./slurmSupport";
import { disconnectSessionFromTunnel, disposeSessionTunnelClient, ensureRemoteSession } from "./tunnelSupport";
import { checkLinkspanHealth } from "./linkspanSupport";

const logger = Logger.getInstance();

class AsyncLock {
    private _acquired = false;
    private _waitQueue: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (!this._acquired) {
            this._acquired = true;
            return;
        }
        return new Promise<void>(resolve => this._waitQueue.push(resolve));
    }

    release(): void {
        const next = this._waitQueue.shift();
        if (next) {
            next();
        } else {
            this._acquired = false;
        }
    }
}

export class JobStatusMonitor {
    private static instance: JobStatusMonitor;

    private monitoringSessions: Map<string, SlurmSession> = new Map();
    private monitoringFailedCounts: Map<string, number> = new Map();
    private _lock = new AsyncLock();
    private sessionPollingInterval = 5000; // 5 seconds
    private preparing = new Set<string>(); // sessions whose Step-1 (sshd + tunnel) prepare is in flight, to keep it run-once


    private constructor() {
        this.monitorSessions();
    }

    public static init(): void {
        if (!JobStatusMonitor.instance) {
            JobStatusMonitor.instance = new JobStatusMonitor();
        }
    }

    public static getInstance(): JobStatusMonitor {
        if (!JobStatusMonitor.instance) {
            throw new Error("JobStatusMonitor not initialized. Call init() first.");
        }
        return JobStatusMonitor.instance;
    }

    // Step 1: drive a running session to ready_to_connect. Guarded to run the networked create once despite the 5s poll.
    private async prepareRemote(session: SlurmSession): Promise<void> {
        if (this.preparing.has(session.id) || session.status !== 'preparing') { return; }
        this.preparing.add(session.id);
        try {
            await ensureRemoteSession(session);
            if (session.status === 'preparing') {
                session.status = 'ready_to_connect';
                logger.info(`Session ${session.name} is ready to connect (remote sshd + tunnel live).`);
                updateSession(session);
            }
            this.monitoringFailedCounts.delete(session.id);
        } catch (err) {
            logger.error(`Failed to prepare session ${session.name} for connect:`, err);
            // Cap retries so a permanently-broken prepare surfaces as disconnected instead of looping every poll.
            // Stays monitored (no stopMonitoringInternal): the slurm branch takes it terminal on job death.
            if (this.doesQualifyToFail(session.id)) {
                session.status = 'disconnected';
                session.errorMessage = `Failed to prepare session for connect: ${err instanceof Error ? err.message : String(err)}`;
                updateSession(session);
            }
        } finally {
            this.preparing.delete(session.id);
        }
    }

    private initializeConnectionInfo() {
        return {
            sshPort: 0,
            logPort: 0,
            apiTunnelId: '',
            apiTunnelAccessToken: '',
            apiPort: 0,
            region: '',
            sshPassword: '',
            sshPrivateKey: '',
            sshTunnelId: '',
            sshTunnelForwardPort: 0
        };
    }

    private doesQualifyToFail(sessionId: string): boolean {
        const failCount = this.monitoringFailedCounts.get(sessionId) || 0;
        this.monitoringFailedCounts.set(sessionId, failCount + 1);
        return failCount >= 3; // Allow up to 3 failures before marking as failed
    }

    // Run a while loop to periodically check the status of all sessions being monitored in background
    private async monitorSessions() {
        while (true) {
            await this._lock.acquire();
            // Snapshot the current sessions so we can release the lock before async polling
            const sessionsToCheck = [...this.monitoringSessions.entries()];
            this._lock.release();

            if (sessionsToCheck.length > 0) { logger.info(`Polling job status for ${sessionsToCheck.length} sessions...`); }
            for (const [sessionId, session] of sessionsToCheck) {
                if (session.jobId) {
                    try {
                        await this._lock.acquire();
                        const stillTracked = this.monitoringSessions.has(sessionId);
                        this._lock.release();
                        if (!stillTracked) {
                            logger.info(`Session ${session.name} is no longer tracked for monitoring. Skipping status update.`);
                            continue;
                        }

                        if (session.connectionInfo?.apiTunnelId && (session.status === 'ready_to_connect' || session.status === 'connecting' || session.status === 'connected')) {
                            // Skip when connectionInfo is missing (after a window reload) - the slurm branch re-derives tunnel info.
                            logger.info(`Session ${session.name} is in status ${session.status}, skipping Slurm status check and using tunnel ping instead.`);

                            checkLinkspanHealth(session).then(() => {
                                this.monitoringFailedCounts.delete(session.id);
                            }).catch(err => {
                                // The session may have left a live state (e.g. Stop) while this ping was in flight; don't clobber it.
                                if (session.status !== 'ready_to_connect' && session.status !== 'connecting' && session.status !== 'connected') { return; }
                                logger.warn(`Health check failed for session ${session.name}:`, err);
                                if (this.doesQualifyToFail(session.id)) {
                                    // Job externally killed, tunnel expired, or walltime exceeded.
                                    session.errorMessage = `Health check failed: ${err.message}`;
                                    session.status = 'disconnected';
                                    updateSession(session);
                                    void disposeSessionTunnelClient(session.id); // free the port; keep refs for a later reattach
                                    // Stays monitored: the slurm branch takes it terminal if the job is actually gone.
                                }
                            });
                            continue;
                        }

                        const { status: slurmStatus, elapsedSec } = await getSlurmJobStatus(session);
                        logger.info(`Polled Slurm job status for session ${session.name}: ${slurmStatus}`);

                        // Anchor the wall-time countdown to SLURM's reported elapsed run-time, not the poll time.
                        if (slurmStatus === SlurmJobStatus.RUNNING && !session.startedAt) {
                            session.startedAt = Date.now() - elapsedSec * 1000;
                            updateSession(session);
                        }

                        if (slurmStatus === SlurmJobStatus.RUNNING && session.status === 'preparing') {
                            getSlurmJobOutput(session).then(output => {
                                // id/region/token come from ensureDevTunnel; only scrape the server port.
                                const ci = session.connectionInfo ?? (session.connectionInfo = this.initializeConnectionInfo());
                                for (const line of output.split('\n')) {
                                    if (line.includes('listening on')) {
                                        ci.apiPort = parseInt(line.split('listening on')[1].trim().split(':')[1]);
                                        updateSession(session);
                                        logger.info(`Session ${session.name}: linkspan server port = ${ci.apiPort}`);
                                        break;
                                    }
                                }
                            }).catch(err => {
                                logger.error(`Failed to get job output for session ${session.name}:`, err);
                                if (!this.doesQualifyToFail(sessionId)) {
                                    logger.warn(`Job output retrieval failed for session ${session.name}, but it does not yet qualify to mark the session as failed. Will retry in the next polling cycle.`);
                                    return;
                                }
                                session.errorMessage = `Failed to get job output: ${err.message || err}`;
                                session.status = 'failed';
                                updateSession(session);
                                this.stopMonitoringInternal(sessionId);
                            });

                            if (session.status === 'preparing' && session.tunnelId &&
                                (session.connectionInfo?.apiPort ?? 0) > 0) {
                                // Step 1 (auto): linkspan is up - ensure the remote sshd + tunnel are live, then mark ready_to_connect.
                                void this.prepareRemote(session);
                            }
                        } else if (slurmStatus === SlurmJobStatus.RUNNING && session.status !== 'preparing'
                            && session.status !== 'ready_to_connect' && session.status !== 'connected'
                            && session.status !== 'connecting' && session.status !== 'disconnected') {
                            // Don't pull a connect-phase / disconnected session back to 'preparing' (would clobber reattach / thrash).
                            session.status = 'preparing';
                            updateSession(session);
                        } else if (slurmStatus === SlurmJobStatus.COMPLETED) {
                            session.status = 'completed';
                            updateSession(session);
                            this.stopMonitoringInternal(sessionId);
                        } else if ([SlurmJobStatus.FAILED, SlurmJobStatus.TIMEOUT, SlurmJobStatus.OUT_OF_MEMORY].includes(slurmStatus)) {
                            session.status = 'failed';
                            session.errorMessage = `Job ended with status: ${slurmStatus}`;
                            updateSession(session);
                            this.stopMonitoringInternal(sessionId);
                        } else if (slurmStatus === SlurmJobStatus.PENDING) {
                            session.status = 'queued';
                            updateSession(session);
                        } else if (slurmStatus === SlurmJobStatus.CANCELLED) {
                            session.status = 'cancelled';
                            updateSession(session);
                            this.stopMonitoringInternal(sessionId);
                        } else if (slurmStatus === SlurmJobStatus.UNKNOWN) {
                            logger.warn(`Received unknown Slurm job status for session ${session.name}`);
                            session.status = 'failed';
                            session.errorMessage = `Job ended with unknown status: ${slurmStatus}`;
                            updateSession(session);
                            this.stopMonitoringInternal(sessionId);
                        }
                    } catch (error: any) {
                        const errorMessage = `Error while monitoring Slurm job status for session ${session.name}: ${error.message || error}`;
                        logger.error(errorMessage, error);
                        if (!this.doesQualifyToFail(sessionId)) {
                            logger.warn(`Slurm job status check failed for session ${session.name}, but it does not yet qualify to mark the session as failed. Will retry in the next polling cycle.`);
                            continue;
                        }

                        // Background poll loop: no dialog. errorMessage is rendered on the session card.
                        session.status = 'failed'; // TODO: Probably unknown or retry
                        session.errorMessage = errorMessage;
                        updateSession(session);
                        this.stopMonitoringInternal(sessionId);
                    }

                }
            }
            await new Promise(resolve => setTimeout(resolve, this.sessionPollingInterval)); // Check every 5 seconds
        }
    }

    private stopMonitoringInternal(sessionId: string) {
        this.monitoringSessions.delete(sessionId);
        this.monitoringFailedCounts.delete(sessionId);
        logger.info(`Stopped monitoring Slurm job status for session ID ${sessionId}`);
    }

    public async stopMonitoring(sessionId: string) {
        await this._lock.acquire();
        try {
            this.stopMonitoringInternal(sessionId);
        } finally {
            this._lock.release();
        }
    }

    public async startMonitoring(session: SlurmSession) {
        await this._lock.acquire();
        try {
            if (session.jobId && !this.monitoringSessions.has(session.id)) {
                this.monitoringSessions.set(session.id, session);
                logger.info(`Started monitoring Slurm job status for session ${session.name} (Job ID: ${session.jobId})`);
            }
        } finally {
            this._lock.release();
        }
    }
}

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
    const localVersionResult = await sshManager.runRemoteCommand(session.cluster, `~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo ""`);

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

async function submitJobToSlurm(session: SlurmSession, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    progress.report({ message: "Submitting job to Slurm..." });
    const sshManager = SshManager.getInstance();

    if (!session.batchScript) {
        const errorMessage = `Batch script is missing for session ${session.name}`;
        logger.error(errorMessage);
        vscode.window.showErrorMessage(errorMessage);
        session.status = 'failed';
        session.errorMessage = errorMessage;
        updateSession(session);
        return false;
    }

    const scriptB64 = Buffer.from(session.batchScript!).toString('base64');
    const submitCommand = `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d | sbatch`;
    logger.info(`Submitting job to Slurm with command: ${submitCommand}`);

    const submitResult = await sshManager.runRemoteCommand(session.cluster, submitCommand);
    if (submitResult.code === 0) {
        const output = submitResult.stdout.trim();
        logger.info(`Job submission output: ${output}`);
        const jobIdMatch = output.match(/Submitted batch job (\d+)/);
        if (jobIdMatch) {
            const jobId = jobIdMatch[1];
            logger.info(`Job submitted successfully with Job ID: ${jobId}`);
            session.jobId = jobId;
            session.status = 'queued'; // Job is submitted and waiting in queue
            session.submittedAt = new Date().getTime();
            updateSession(session);
            return true;
        } else {
            const errorMessage = `Failed to parse job ID from sbatch output: ${output}`;
            logger.error(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
            session.status = 'failed';
            session.errorMessage = errorMessage;
            updateSession(session);
            return false;
        }
    } else {
        const errorMessage = `Job submission failed: ${submitResult.stderr}`;
        logger.error(errorMessage);
        vscode.window.showErrorMessage(errorMessage);
        session.status = 'failed';
        session.errorMessage = errorMessage;
        updateSession(session);
        return false;
    }
}

export async function launchSessionWithProgress(session: SlurmSession) {

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

        const submissionSuccess = await submitJobToSlurm(session, progress);
        if (!submissionSuccess) {
            return;
        }

        JobStatusMonitor.getInstance().startMonitoring(session);

    });

}

export async function cancelRunningSession(session: SlurmSession) {
    // Implement logic to cancel a running session, e.g. by sending scancel command for Slurm jobs
    logger.info(`Cancelling session: ${session.name}`);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Cancelling session ${session.name}...`,
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            logger.info(`Session cancellation interrupted: ${session.name}`);
            session.status = 'cancelled';
            updateSession(session);
        });
        progress.report({ message: "Cancelling session..." });

        try {
            if (session.jobId) {
                const sshManager = SshManager.getInstance();
                const cancelCommand = `scancel ${session.jobId}`;
                logger.info(`Sending cancellation command for session ${session.name}: ${cancelCommand}`);
                const cancelResult = await sshManager.runRemoteCommand(session.cluster, cancelCommand);
                if (cancelResult.code === 0) {
                    logger.info(`Cancellation command sent successfully for session ${session.name}`);
                    session.status = 'cancelled';
                    updateSession(session);
                } else {
                    const errorMessage = `Failed to send cancellation command for session ${session.name}. Error: ${cancelResult.stderr}`;
                    logger.error(errorMessage);
                    vscode.window.showErrorMessage(errorMessage);
                    session.status = 'failed';
                    session.errorMessage = errorMessage;
                    updateSession(session);
                }
            } else {
                session.status = 'cancelled';
                updateSession(session);
                logger.warn(`Session ${session.name} does not have an associated job ID. Marking as cancelled without sending cancellation command.`);
            }
        } catch (error: any) {
            const errorMessage = `Error while cancelling session ${session.name}: ${error.message || error}`;
            logger.error(errorMessage, error);
            vscode.window.showErrorMessage(errorMessage);
            session.status = 'failed';
            session.errorMessage = errorMessage;
            updateSession(session);
        }

        if (session.status === 'cancelled') {
            // Job is being cancelled: full local teardown (config + key + refs).
            try {
                await disconnectSessionFromTunnel(session);
            } catch (err) {
                logger.error(`Failed to disconnect session ${session.name} from tunnel: ${err}`);
            }
        } else {
            // scancel failed / job may still be alive: free the port but keep key + refs so reattach still works.
            await disposeSessionTunnelClient(session.id);
        }

        JobStatusMonitor.getInstance().stopMonitoring(session.id);
    });
}

import { SlurmJobStatus, SlurmSession, TunnelCredential } from "../models";
import * as vscode from 'vscode';
import { Logger, errMsg } from './../logger';
import { updateSession } from "../extensionStore";
import { SshManager } from "./sshSupport";
import { getSlurmJobOutput, getSlurmJobStatus } from "./slurmSupport";
import { buildSlurmScript } from "./slurmParse";
import { computeStatusTransition, isRelayLive } from "./sessionMachine";
import { checkSlurmAvailability, checkLinkspanInstallation, installLinkspan, submitJobToSlurm } from "./slurmLaunch";
import { disconnectSessionFromTunnel, disposeTunnelClient, ensureDevTunnel, ensureRemoteSession, getDevTunnelCredentials } from "./tunnelSupport";
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

// Owned by sessionProvider (one per window); polls SLURM job status in the background and drives session
// status transitions. Instance-based (no global singleton) so its lifecycle is explicit and it is mockable.
export class JobStatusMonitor {
    private monitoringSessions: Map<string, SlurmSession> = new Map();
    private monitoringFailedCounts: Map<string, number> = new Map();
    private _lock = new AsyncLock();
    private sessionPollingInterval = 5000; // 5 seconds
    private preparing = new Set<string>(); // sessions whose Step-1 (sshd + tunnel) prepare is in flight, to keep it run-once

    constructor() {
        this.monitorSessions();
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

                        if (session.connectionInfo?.apiTunnelId && isRelayLive(session.status)) {
                            // Skip when connectionInfo is missing (after a window reload) - the slurm branch re-derives tunnel info.
                            logger.info(`Session ${session.name} is in status ${session.status}, skipping Slurm status check and using tunnel ping instead.`);

                            checkLinkspanHealth(session).then(() => {
                                this.monitoringFailedCounts.delete(session.id);
                            }).catch(err => {
                                // The session may have left a live state (e.g. Stop) while this ping was in flight; don't clobber it.
                                if (!isRelayLive(session.status)) { return; }
                                logger.warn(`Health check failed for session ${session.name}:`, err);
                                if (this.doesQualifyToFail(session.id)) {
                                    // Job externally killed, tunnel expired, or walltime exceeded.
                                    session.errorMessage = `Health check failed: ${err.message}`;
                                    session.status = 'disconnected';
                                    updateSession(session);
                                    void disposeTunnelClient(session.id); // free the port; keep refs for a later reattach
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
                        } else {
                            // Apply the pure status-transition decision (see sessionMachine.computeStatusTransition).
                            if (slurmStatus === SlurmJobStatus.UNKNOWN) { logger.warn(`Received unknown Slurm job status for session ${session.name}`); }
                            const t = computeStatusTransition(session.status, slurmStatus);
                            if (t.next) {
                                session.status = t.next;
                                if (t.error) { session.errorMessage = t.error; }
                                updateSession(session);
                            }
                            if (t.stopMonitoring) { this.stopMonitoringInternal(sessionId); }
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
            await new Promise(resolve => setTimeout(resolve, this.sessionPollingInterval));
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

// Pre-launch orchestration: fetch tunnel credentials, ensure the dev tunnel exists (persisting its id before it
// goes into the script), and generate the SLURM batch script. Throws a contextual error on a step's failure;
// sessionProvider._prepareLaunchSession owns the dialog + errorMessage.
export async function prepareLaunch(session: SlurmSession): Promise<void> {
    let creds: TunnelCredential;
    try { creds = await getDevTunnelCredentials(); }
    catch (err) { throw new Error(`Failed to get tunnel credentials: ${errMsg(err)}`); }

    try { await ensureDevTunnel(session); }
    catch (err) { throw new Error(`Failed to create dev tunnel: ${errMsg(err)}`); }

    try { session.batchScript = buildSlurmScript(session, creds); }
    catch (err) { throw new Error(`Failed to generate Slurm script: ${errMsg(err)}`); }

    session.errorMessage = '';
    updateSession(session);
}

// Launch composition. Each step (in slurmLaunch) throws on failure; the rejection propagates to the caller
// (sessionProvider._launchSession) which owns the failed-status transition and the error dialog. The caller
// wraps this in vscode.window.withProgress and passes the progress reporter + the monitor it owns.
export async function launchSession(session: SlurmSession, monitor: JobStatusMonitor, progress: vscode.Progress<{ message?: string }>): Promise<void> {
    logger.info(`Initiating launch for session: ${session.name}`);
    const run = SshManager.getInstance();

    progress.report({ message: "Checking Slurm availability on cluster" });
    await checkSlurmAvailability(session, run, logger);

    progress.report({ message: "Checking Linkspan installation on cluster" });
    if (!await checkLinkspanInstallation(session, run, logger)) {
        progress.report({ message: "Installing Linkspan on cluster" });
        await installLinkspan(session, run, logger);
    }

    progress.report({ message: "Submitting job to Slurm..." });
    await submitJobToSlurm(session, run, logger);
    updateSession(session); // persist jobId + queued status set in-memory by submitJobToSlurm
    monitor.startMonitoring(session);
}

// Stop composition. Records (does not show) a stop failure; teardown always runs, then it rethrows so the
// caller (sessionProvider._stopSessionExecution) owns the dialog and the false "completed" toast is skipped.
export async function stopSession(session: SlurmSession, monitor: JobStatusMonitor, progress: vscode.Progress<{ message?: string }>): Promise<void> {
    logger.info(`Stopping session: ${session.name}`);
    progress.report({ message: "Stopping session..." });

    let stopError: Error | undefined;
    try {
        if (session.jobId) {
            const stopCommand = `scancel ${session.jobId}`;
            logger.info(`Sending stop command for session ${session.name}: ${stopCommand}`);
            const stopResult = await SshManager.getInstance().runRemoteCommand(session.cluster, stopCommand);
            if (stopResult.code !== 0) {
                throw new Error(`Failed to send stop command for session ${session.name}: ${stopResult.stderr}`);
            }
            logger.info(`Stop command sent successfully for session ${session.name}`);
        } else {
            logger.warn(`Session ${session.name} has no job ID; marking stopped without scancel.`);
        }
        session.status = 'stopped';
        updateSession(session);
    } catch (error: any) {
        stopError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Error while stopping session ${session.name}:`, error);
        session.status = 'failed';
        session.errorMessage = stopError.message;
        updateSession(session);
    }

    // Teardown always runs: full local teardown (config + key + refs) on success; on failure the job may
    // still be alive, so free only the port and keep key + refs so reattach still works.
    if (session.status === 'stopped') {
        try {
            await disconnectSessionFromTunnel(session);
        } catch (err) {
            logger.error(`Failed to disconnect session ${session.name} from tunnel: ${err}`);
        }
    } else {
        await disposeTunnelClient(session.id);
    }

    monitor.stopMonitoring(session.id);

    if (stopError) { throw stopError; }
}

import { SlurmJobStatus, SlurmSession, TunnelCredential, PromptObserver } from '../models';
import * as vscode from 'vscode';
import { Logger, errMsg } from './../logger';
import { updateSession } from '../extensionStore';
import { SshManager } from './sshSupport';
import { getSlurmJobOutput, getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript } from './slurmParse';
import { computeStatusTransition, isRelayLive } from './sessionMachine';
import { checkSlurmAvailability, checkLinkspanInstallation, installLinkspan, submitJobToSlurm, RemoteRunner } from './slurmLaunch';
import { disconnectSessionFromTunnel, disposeTunnelClient, ensureDevTunnel, ensureRemoteSession, getDevTunnelCredentials } from './tunnelSupport';
import { checkLinkspanHealth } from './linkspanSupport';

const logger = Logger.getInstance();
const POLLING_INTERVAL_MS = 5000;
const MAX_POLL_FAILURES = 3;

class AsyncLock {
    private acquired = false;
    private waitQueue: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (!this.acquired) {
            this.acquired = true;
            return;
        }
        return new Promise<void>(resolve => this.waitQueue.push(resolve));
    }

    release(): void {
        const next = this.waitQueue.shift();
        if (next) {
            next();
        }
        else {
            this.acquired = false;
        }
    }
}

export class JobStatusMonitor {
    private monitoringSessions: Map<string, SlurmSession> = new Map();
    private monitoringFailedCounts: Map<string, number> = new Map();
    private lock = new AsyncLock();
    private remotePrepareInFlight = new Set<string>();

    constructor() {
        this.monitorSessions();
    }

    // Step 1: drive a running session to ready_to_connect (run-once guarded against the 5s poll).
    private async prepareRemote(session: SlurmSession): Promise<void> {
        if (this.remotePrepareInFlight.has(session.id) || session.status !== 'preparing') { return; }
        this.remotePrepareInFlight.add(session.id);
        try {
            await ensureRemoteSession(session);
            if (session.status === 'preparing') {
                session.status = 'ready_to_connect';
                logger.info(`Session ${session.name} is ready to connect (remote sshd + tunnel live).`);
                updateSession(session);
            }
            this.monitoringFailedCounts.delete(session.id);
        }
        catch (err) {
            logger.error(`Failed to prepare session ${session.name} for connect:`, err);
            // Stays monitored: the slurm branch takes it terminal on job death.
            if (this.shouldGiveUp(session.id)) {
                session.status = 'disconnected';
                session.errorMessage = `Failed to prepare session for connect: ${errMsg(err)}`;
                updateSession(session);
            }
        }
        finally {
            this.remotePrepareInFlight.delete(session.id);
        }
    }

    private newConnectionInfo() {
        return {
            sshPort: 0,
            apiTunnelId: '',
            apiTunnelAccessToken: '',
            apiPort: 0,
            region: '',
            sshPassword: '',
            sshPrivateKey: '',
            sshTunnelId: '',
            sshTunnelForwardPort: 0,
        };
    }

    // Counts a poll failure for the session and reports whether retries are now exhausted.
    private shouldGiveUp(sessionId: string): boolean {
        const failCount = this.monitoringFailedCounts.get(sessionId) || 0;
        this.monitoringFailedCounts.set(sessionId, failCount + 1);
        return failCount >= MAX_POLL_FAILURES;
    }

    private async monitorSessions() {
        while (true) {
            await this.lock.acquire();
            const sessionsToCheck = [...this.monitoringSessions.entries()]; // snapshot, so the lock isn't held across async polling
            this.lock.release();

            if (sessionsToCheck.length > 0) { logger.info(`Polling job status for ${sessionsToCheck.length} sessions...`); }
            for (const [sessionId, session] of sessionsToCheck) {
                if (session.jobId) {
                    try {
                        await this.lock.acquire();
                        const stillTracked = this.monitoringSessions.has(sessionId);
                        this.lock.release();
                        if (!stillTracked) {
                            logger.info(`Session ${session.name} is no longer tracked for monitoring. Skipping status update.`);
                            continue;
                        }

                        if (session.connectionInfo?.apiTunnelId && isRelayLive(session.status)) {
                            logger.info(`Session ${session.name} is in status ${session.status}, health-pinging the tunnel instead of polling Slurm.`);

                            checkLinkspanHealth(session).then(() => {
                                this.monitoringFailedCounts.delete(session.id);
                            }).catch((err) => {
                                // The session may have left a live state (e.g. Stop) while this ping was in flight; don't clobber it.
                                if (!isRelayLive(session.status)) { return; }
                                logger.warn(`Health check failed for session ${session.name}:`, err);
                                if (this.shouldGiveUp(session.id)) {
                                    session.errorMessage = `Health check failed: ${err.message}`;
                                    session.status = 'disconnected';
                                    updateSession(session);
                                    void disposeTunnelClient(session.id);
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
                            getSlurmJobOutput(session).then((output) => {
                                // id/region/token already came from ensureDevTunnel; only the server port is scraped here.
                                const ci = session.connectionInfo ?? (session.connectionInfo = this.newConnectionInfo());
                                for (const line of output.split('\n')) {
                                    if (line.includes('listening on')) {
                                        ci.apiPort = parseInt(line.split('listening on')[1].trim().split(':')[1]);
                                        updateSession(session);
                                        logger.info(`Session ${session.name}: linkspan server port = ${ci.apiPort}`);
                                        break;
                                    }
                                }
                            }).catch((err) => {
                                logger.error(`Failed to get job output for session ${session.name}:`, err);
                                if (!this.shouldGiveUp(sessionId)) {
                                    logger.warn(`Job output retrieval failed for session ${session.name}, but it does not yet qualify to mark the session as failed. Will retry in the next polling cycle.`);
                                    return;
                                }
                                session.errorMessage = `Failed to get job output: ${err.message || err}`;
                                session.status = 'failed';
                                updateSession(session);
                                this.untrackSession(sessionId);
                            });

                            if (session.status === 'preparing' && session.tunnelId
                                && (session.connectionInfo?.apiPort ?? 0) > 0) {
                                void this.prepareRemote(session);
                            }
                        }
                        else {
                            if (slurmStatus === SlurmJobStatus.UNKNOWN) { logger.warn(`Received unknown Slurm job status for session ${session.name}`); }
                            const t = computeStatusTransition(session.status, slurmStatus);
                            if (t.next) {
                                session.status = t.next;
                                if (t.error) { session.errorMessage = t.error; }
                                updateSession(session);
                            }
                            if (t.stopMonitoring) { this.untrackSession(sessionId); }
                        }
                    }
                    catch (error) {
                        const errorMessage = `Error while monitoring Slurm job status for session ${session.name}: ${errMsg(error)}`;
                        logger.error(errorMessage, error);
                        if (!this.shouldGiveUp(sessionId)) {
                            logger.warn(`Slurm job status check failed for session ${session.name}, but it does not yet qualify to mark the session as failed. Will retry in the next polling cycle.`);
                            continue;
                        }

                        session.status = 'failed';
                        session.errorMessage = errorMessage;
                        updateSession(session);
                        this.untrackSession(sessionId);
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
        }
    }

    private untrackSession(sessionId: string) {
        this.monitoringSessions.delete(sessionId);
        this.monitoringFailedCounts.delete(sessionId);
        logger.info(`Stopped monitoring Slurm job status for session ID ${sessionId}`);
    }

    public async stopMonitoring(sessionId: string) {
        await this.lock.acquire();
        try {
            this.untrackSession(sessionId);
        }
        finally {
            this.lock.release();
        }
    }

    public async startMonitoring(session: SlurmSession) {
        await this.lock.acquire();
        try {
            if (session.jobId && !this.monitoringSessions.has(session.id)) {
                this.monitoringSessions.set(session.id, session);
                logger.info(`Started monitoring Slurm job status for session ${session.name} (Job ID: ${session.jobId})`);
            }
        }
        finally {
            this.lock.release();
        }
    }
}

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

export async function launchSession(session: SlurmSession, monitor: JobStatusMonitor, progress: vscode.Progress<{ message?: string }>, observer: PromptObserver): Promise<void> {
    logger.info(`Initiating launch for session: ${session.name}`);
    const run: RemoteRunner = { runRemoteCommand: (host, command) => SshManager.getInstance().runRemoteCommand(host, command, observer) };

    progress.report({ message: 'Checking Slurm availability on cluster' });
    await checkSlurmAvailability(session, run, logger);

    progress.report({ message: 'Checking Linkspan installation on cluster' });
    if (!await checkLinkspanInstallation(session, run, logger)) {
        progress.report({ message: 'Installing Linkspan on cluster' });
        await installLinkspan(session, run, logger);
    }

    progress.report({ message: 'Submitting job to Slurm...' });
    await submitJobToSlurm(session, run, logger);
    updateSession(session);
    monitor.startMonitoring(session);
}

export async function stopSession(session: SlurmSession, monitor: JobStatusMonitor, progress: vscode.Progress<{ message?: string }>): Promise<void> {
    logger.info(`Stopping session: ${session.name}`);
    progress.report({ message: 'Stopping session...' });

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
        }
        else {
            logger.warn(`Session ${session.name} has no job ID; marking stopped without scancel.`);
        }
        session.status = 'stopped';
        updateSession(session);
    }
    catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Error while stopping session ${session.name}:`, error);
        session.status = 'failed';
        session.errorMessage = stopError.message;
        updateSession(session);
    }

    // On failure the job may still be alive, so free only the local port and keep the refs for reattach.
    if (session.status === 'stopped') {
        try {
            await disconnectSessionFromTunnel(session);
        }
        catch (err) {
            logger.error(`Failed to disconnect session ${session.name} from tunnel: ${err}`);
        }
    }
    else {
        await disposeTunnelClient(session.id);
    }

    monitor.stopMonitoring(session.id);

    if (stopError) { throw stopError; }
}

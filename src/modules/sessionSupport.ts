import { SlurmJobStatus, SlurmSession, TunnelCredential, PromptObserver } from '../models';
import * as vscode from 'vscode';
import { Logger, errMsg } from './../logger';
import { updateSession } from '../extensionStore';
import { SshManager } from './sshSupport';
import { getSlurmJobOutput, getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript } from './slurmParse';
import { computeStatusTransition, isRelayLive, isTerminal, isWallTimeExpired, unreachableStatus } from './sessionMachine';
import { checkSlurmAvailability, checkLinkspanInstallation, installLinkspan, submitJobToSlurm, RemoteRunner } from './slurmLaunch';
import { disconnectSessionFromTunnel, disposeTunnelClient, ensureDevTunnel, ensureRemoteSession, getDevTunnelCredentials, removeDevTunnel } from './tunnelSupport';
import { checkLinkspanHealth } from './linkspanSupport';

const logger = Logger.getInstance();
const POLLING_INTERVAL_MS = 5000;
// Consecutive failed /health pings before we stop trusting the tunnel and cross-check the job over batch sacct.
const HEALTH_GIVEUP = 6;
// Lets an authoritative sacct verdict win first when reachable (it can lag ~HEALTH_GIVEUP polls in the relay-live path).
const WALL_TIME_GRACE_MS = 30_000;

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
    private healthFailedCounts: Map<string, number> = new Map();
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
        }
        catch (err) {
            // A dev-tunnel/linkspan API blip while bringing Step 1 up is transient, not job death — hold 'preparing' and retry.
            logger.warn(`Could not prepare session ${session.name} for connect (will retry): ${errMsg(err)}`);
            session.errorMessage = `Preparing remote session: ${errMsg(err)}`;
            updateSession(session);
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

                        // Without this a terminal-but-still-tracked session resurrects: computeStatusTransition('completed', RUNNING) → 'preparing'.
                        if (isTerminal(session.status)) {
                            void disposeTunnelClient(session.id);
                            this.untrackSession(sessionId);
                            continue;
                        }

                        // The job can't outlive its wall time, so stop it even when sacct is unreachable; skip an in-flight stop.
                        if (session.status !== 'stopping' && isWallTimeExpired(session, Date.now() - WALL_TIME_GRACE_MS)) {
                            session.status = 'stopped';
                            session.errorMessage = '';
                            updateSession(session);
                            void disposeTunnelClient(session.id);
                            this.untrackSession(sessionId);
                            continue;
                        }

                        if (session.connectionInfo?.apiTunnelId && isRelayLive(session.status)) {
                            const healthFails = this.healthFailedCounts.get(session.id) ?? 0;
                            if (healthFails < HEALTH_GIVEUP) {
                                logger.info(`Session ${session.name} is in status ${session.status}, health-pinging the tunnel instead of polling Slurm.`);
                                checkLinkspanHealth(session).then(() => {
                                    this.healthFailedCounts.delete(session.id);
                                }).catch((err) => {
                                    if (!isRelayLive(session.status)) { return; } // left a live state (e.g. Stop) mid-ping
                                    // A /health blip is not job death: keep the relay (it self-heals via enableReconnect), count, cross-check below.
                                    this.healthFailedCounts.set(session.id, (this.healthFailedCounts.get(session.id) ?? 0) + 1);
                                    logger.warn(`Health check failed for session ${session.name} (relay kept): ${errMsg(err)}`);
                                    session.errorMessage = `Health check failed: ${errMsg(err)}`;
                                    updateSession(session);
                                });
                                continue;
                            }

                            // /health gave up — only an authoritative sacct terminal state may now tear the relay down.
                            try {
                                const { status: slurmStatus } = await getSlurmJobStatus(session);
                                const t = computeStatusTransition(session.status, slurmStatus);
                                if (t.stopMonitoring) {
                                    session.status = t.next!;
                                    if (t.error) { session.errorMessage = t.error; }
                                    updateSession(session);
                                    void disposeTunnelClient(session.id);
                                    this.untrackSession(sessionId);
                                }
                                else {
                                    this.healthFailedCounts.delete(session.id); // alive — resume health-pinging
                                }
                            }
                            catch (err) {
                                logger.warn(`Liveness cross-check unreachable for session ${session.name} (keeping relay): ${errMsg(err)}`);
                            }
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
                                // .err not written yet, or login node briefly unreachable — not death; keep 'preparing' and retry.
                                logger.warn(`Job output not yet available for session ${session.name} (will retry): ${errMsg(err)}`);
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
                            if (t.stopMonitoring) {
                                void disposeTunnelClient(session.id); // free any relay on authoritative job death
                                this.untrackSession(sessionId);
                            }
                        }
                    }
                    catch (error) {
                        // Login node unreachable (dead ControlMaster, Duo-needed under BatchMode) — not death; stay recoverable.
                        logger.warn(`Cluster unreachable while polling session ${session.name} (will retry): ${errMsg(error)}`);
                        const next = unreachableStatus(session.status);
                        if (next && session.status !== next) {
                            session.status = next;
                            session.errorMessage = `Cluster unreachable: ${errMsg(error)}`;
                            updateSession(session);
                        }
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
        }
    }

    private untrackSession(sessionId: string) {
        this.monitoringSessions.delete(sessionId);
        this.healthFailedCounts.delete(sessionId);
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

    // Fresh launch: drop the prior run's tunnel so its ports don't accumulate toward Microsoft's PortsPerTunnel (10) cap.
    await removeDevTunnel(session);

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

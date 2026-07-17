import { Metric, SlurmJobStatus, SlurmSession, TunnelCredential, PromptObserver } from '../models';
import * as vscode from 'vscode';
import { Logger, errMsg } from './../logger';
import { updateSession, setStatus } from '../extensionStore';
import { recordSessionRun, sacctStats } from '../sessionRunSupport';
import { SshManager } from './sshSupport';
import { getMetricsViaSrun, getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript } from './slurmParse';
import { computeStatusTransition, isRelayLive, isTerminal, isWallTimeExpired, unreachableStatus, StatusTransition } from './sessionMachine';
import { checkSlurmAvailability, checkLinkspanInstallation, installLinkspan, submitJobToSlurm, RemoteRunner } from './slurmLaunch';
import { disconnectSessionFromTunnel, disposeTunnelClient, ensureDevTunnel, ensureRemoteSession, getDevTunnelCredentials, isTunnelClientConnected, linkspanEndpoint, removeDevTunnel } from './tunnelSupport';
import { getHealth, getMetrics } from './linkspanSupport';
import { appendMetric, writeSessionStats, resetLive } from './sessionMetricsStore';

const logger = Logger.getInstance();
const POLLING_INTERVAL_MS = 5000;
// How often to refresh the in-run sacct copy; coarse since usage only flushes at step end.
const SACCT_REFRESH_MS = 30_000;
// Consecutive failed /health pings before we stop trusting the tunnel and cross-check the job over batch sacct.
const HEALTH_GIVEUP = 6;
// Lets an authoritative sacct verdict win first when reachable (it can lag ~HEALTH_GIVEUP polls in the relay-live path).
const WALL_TIME_GRACE_MS = 30_000;

// One independent poll loop per active session, created on startMonitoring and torn down on stop. No shared lock:
// each loop only mutates its own session and updateSession is synchronous, so per-session ticks never race.
export class SessionMonitor {
    private sessions = new Map<string, SlurmSession>();
    private tickers = new Map<string, ReturnType<typeof setInterval>>();
    private ticking = new Set<string>(); // per-session reentrancy guard: a slow tick must not overlap its next fire
    private healthFailedCounts = new Map<string, number>();
    private lastSacctAt = new Map<string, number>(); // throttles the in-run sacct refresh, per session

    // Every monitor line is "Session <name>: <msg>" — one format, one place.
    private log(session: SlurmSession, msg: string): void { logger.info(`Session ${session.name}: ${msg}`); }
    private warn(session: SlurmSession, msg: string): void { logger.warn(`Session ${session.name}: ${msg}`); }

    private healthFails(id: string): number { return this.healthFailedCounts.get(id) ?? 0; }
    private bumpHealthFails(id: string): number { const n = this.healthFails(id) + 1; this.healthFailedCounts.set(id, n); return n; }

    private endSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) { void recordSessionRun(session); }
        void disposeTunnelClient(sessionId);
        this.stopMonitoring(sessionId);
    }

    // Apply a poll transition: persist a status change, tear down on an authoritative terminal verdict.
    private applyTransition(session: SlurmSession, t: StatusTransition): void {
        if (t.next) { setStatus(session, t.next, t.error); } // t.error is undefined or non-empty, so it sets only on a real error
        if (t.stopMonitoring) { this.endSession(session.id); }
    }

    // Tunnel health gave up — only an authoritative sacct terminal state may tear the session down; else it's alive, resume pinging.
    private async crossCheckSlurmForDeath(session: SlurmSession): Promise<void> {
        try {
            const t = computeStatusTransition(session.status, (await getSlurmJobStatus(session)).status);
            if (t.stopMonitoring) { this.applyTransition(session, t); }
            else { this.healthFailedCounts.delete(session.id); }
        }
        catch (err) {
            this.warn(session, `healthcheck (slurm): unreachable (will retry): ${errMsg(err)}`);
        }
    }

    // Shared running-session poll policy: probe over the tunnel until HEALTH_GIVEUP consecutive failures, then fall
    // back to an authoritative sacct cross-check for job death. The probe differs by phase (bring-up vs relay ping).
    private async pingOrCrossCheck(session: SlurmSession, probe: () => Promise<void>): Promise<void> {
        if (this.healthFails(session.id) < HEALTH_GIVEUP) { await probe(); }
        else { await this.crossCheckSlurmForDeath(session); }
    }

    // Step 1: drive a running session to ready_to_connect. Awaited under tick()'s reentrancy guard, so it can't overlap
    // its own next fire — no separate in-flight guard needed. The caller has already checked status === 'preparing'.
    private async prepareRemote(session: SlurmSession): Promise<void> {
        try {
            await ensureDevTunnel(session); // re-mint tunnel id + Connect token (also valid after a reload dropped them)
            const { baseUrl, headers } = linkspanEndpoint(session);
            await getHealth(baseUrl, headers); // poll the tunnel: throws until linkspan is up and answering /health
            await ensureRemoteSession(session); // linkspan is up — start the sshd and forward it (all over the tunnel)
            if (session.status === 'preparing') { // may have left 'preparing' during the awaits (e.g. user hit Stop)
                this.healthFailedCounts.delete(session.id); // Step 1 up — clear the prepare-failure tally
                this.log(session, 'linkspan is ready to connect.');
                setStatus(session, 'ready_to_connect', ''); // clear any transient-retry warning now that Step 1 is up
            }
        }
        catch (err) {
            // linkspan not up yet (health still failing) or a tunnel API blip — transient, not job death; hold 'preparing' and retry.
            // Count it so the monitor cross-checks sacct for job death after HEALTH_GIVEUP tries.
            this.bumpHealthFails(session.id);
            this.warn(session, `linkspan unreachable (will retry): ${errMsg(err)}`);
            session.errorMessage = `Preparing remote session: ${errMsg(err)}`;
            updateSession(session);
        }
    }

    // One independent poll for a single session. Reentrancy-guarded so a slow tick never overlaps its own next fire.
    private async tick(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || this.ticking.has(sessionId)) { return; }
        this.ticking.add(sessionId);
        try {
            // Without this a terminal-but-still-tracked session resurrects: computeStatusTransition('stopped', RUNNING) → 'preparing'.
            if (isTerminal(session.status)) {
                this.endSession(sessionId);
                return;
            }

            // SLURM kills the job at its wall time. Stop the moment we pass it AND the link is already gone (relay
            // dropped, or never connected) — that's the job dying on schedule, no reason to grind through health-ping
            // retries first. Only hold the grace while the relay still looks connected: our clock may be ahead of the
            // cluster's, or SLURM's KillWait may be running the job a little past --time, and we don't want to tear down
            // a session that still works. Skip an in-flight stop.
            const now = Date.now();
            if (session.status !== 'stopping' && isWallTimeExpired(session, now)
                && (!isTunnelClientConnected(session.id) || isWallTimeExpired(session, now - WALL_TIME_GRACE_MS))) {
                setStatus(session, 'stopped', '');
                this.endSession(sessionId);
                return;
            }

            // Job is running but Step 1 isn't up yet: drive the bring-up over the tunnel (prepareRemote), not Slurm,
            // cross-checking sacct for job death only after HEALTH_GIVEUP prepare failures — so a running session never
            // SSH-polls the login node. prepareRemote advances to ready_to_connect once linkspan answers.
            if (session.status === 'preparing' && session.tunnelId && (session.connectionInfo?.apiPort ?? 0) > 0) {
                await this.pingOrCrossCheck(session, () => this.prepareRemote(session));
                return;
            }

            if (session.connectionInfo?.apiTunnelId && isRelayLive(session.status)) {
                // Pulling /metrics is the health check: success = alive + a live sample; HEALTH_GIVEUP failures
                // cross-check sacct for death. Transport follows the relay — devtunnel when it owns the tunnel, else srun.
                await this.pingOrCrossCheck(session, async () => {
                    try {
                        const m = await this.pullMetrics(session);
                        this.healthFailedCounts.delete(session.id);
                        // Samples go to the per-session metrics file; only write the record when a persisted field changes.
                        if (session.errorMessage) { session.errorMessage = ''; updateSession(session); }
                        if (m.memBytes !== undefined) { appendMetric(session.id, { ...m, atMs: Date.now() }); }
                        void this.refreshStats(session);
                    }
                    catch (err) {
                        if (isRelayLive(session.status)) {
                            const attempt = this.bumpHealthFails(session.id);
                            this.warn(session, `healthcheck (metrics): failed (attempt ${attempt}/${HEALTH_GIVEUP}): ${errMsg(err)}`);
                        }
                    }
                });
                return;
            }

            const { status: slurmStatus, elapsedSec } = await getSlurmJobStatus(session);
            this.log(session, `healthcheck (slurm): status=${slurmStatus}`);

            // Anchor the wall-time countdown to SLURM's reported elapsed run-time, not the poll time.
            if (slurmStatus === SlurmJobStatus.RUNNING && !session.startedAt) {
                session.startedAt = Date.now() - elapsedSec * 1000;
                updateSession(session);
            }

            // Pre-running states (submitting/queued/unreachable): sacct drives the transition. RUNNING promotes to
            // 'preparing', after which the tunnel-side branch above takes over — no more login-node polls.
            if (slurmStatus === SlurmJobStatus.UNKNOWN) { this.warn(session, `job status=${slurmStatus}`); }
            this.applyTransition(session, computeStatusTransition(session.status, slurmStatus));
        }
        catch (error) {
            // Login node unreachable (dead ControlMaster, Duo-needed under BatchMode) — not death; stay recoverable.
            this.warn(session, `cluster unreachable (will retry): ${errMsg(error)}`);
            const next = unreachableStatus(session.status);
            if (next && session.status !== next) {
                setStatus(session, next, `Cluster unreachable: ${errMsg(error)}`);
            }
        }
        finally {
            this.ticking.delete(sessionId);
        }
    }

    private pullMetrics(session: SlurmSession): Promise<Metric> {
        if (!isTunnelClientConnected(session.id)) { return getMetricsViaSrun(session); }
        const { baseUrl, headers } = linkspanEndpoint(session);
        return getMetrics(baseUrl, headers);
    }

    // Throttled sacct refresh, fire-and-forget from the health path (sacctStats swallows its own errors).
    private async refreshStats(session: SlurmSession): Promise<void> {
        const now = Date.now();
        if (now - (this.lastSacctAt.get(session.id) ?? 0) < SACCT_REFRESH_MS) { return; }
        this.lastSacctAt.set(session.id, now);
        const m = await sacctStats(session);
        if (m && Object.keys(m).length) { writeSessionStats(session.id, m); }
    }

    // Begin an independent poll loop for one active session (no-op if already running or not yet launched). The first
    // poll fires now so status isn't stale for a full interval; the rest run on the interval.
    public startMonitoring(session: SlurmSession): void {
        if (!session.jobId || this.tickers.has(session.id)) { return; }
        this.sessions.set(session.id, session);
        this.tickers.set(session.id, setInterval(() => void this.tick(session.id), POLLING_INTERVAL_MS));
        this.log(session, `monitoring started (JobId=${session.jobId})`);
        void this.tick(session.id);
    }

    // Stop and forget one session's loop.
    public stopMonitoring(sessionId: string): void {
        const name = this.sessions.get(sessionId)?.name ?? sessionId;
        const ticker = this.tickers.get(sessionId);
        if (ticker) { clearInterval(ticker); }
        this.tickers.delete(sessionId);
        this.sessions.delete(sessionId);
        this.ticking.delete(sessionId);
        this.healthFailedCounts.delete(sessionId);
        this.lastSacctAt.delete(sessionId);
        logger.info(`Session ${name}: monitoring stopped.`);
    }

    // Tear down every loop (window close).
    public dispose(): void {
        for (const id of [...this.tickers.keys()]) { this.stopMonitoring(id); }
    }
}

export async function prepareLaunch(session: SlurmSession): Promise<void> {
    let creds: TunnelCredential;
    try { creds = await getDevTunnelCredentials(); }
    catch (err) { throw new Error(`Failed to get tunnel credentials: ${errMsg(err)}`); }

    // Fresh launch: drop the prior run's connection info (dead sshd port/keys, old apiPort/tunnel refs) BEFORE re-minting,
    // so ensureDevTunnel builds clean state and the apiPort pinned below survives to the monitor. Must precede ensureDevTunnel.
    session.connectionInfo = undefined;
    resetLive(session.id); // clear the prior run's live samples + stats, keep the run history

    // Fresh launch: drop the prior run's tunnel so its ports don't accumulate toward Microsoft's PortsPerTunnel (10) cap.
    await removeDevTunnel(session);

    try { await ensureDevTunnel(session); }
    catch (err) { throw new Error(`Failed to create dev tunnel: ${errMsg(err)}`); }

    // Pin linkspan's API port so csbridge knows the tunnel URL without scraping the log or enumerating ports.
    // ponytail: random high port; ~1/12000 collision on a shared compute node (linkspan log.Fatals if taken, session then fails) — probe a free port on the node if it ever bites.
    session.connectionInfo!.apiPort = 20000 + Math.floor(Math.random() * 12000);

    try { session.batchScript = buildSlurmScript(session, creds); }
    catch (err) { throw new Error(`Failed to generate Slurm script: ${errMsg(err)}`); }

    session.errorMessage = '';
    updateSession(session);
}

export async function launchSession(session: SlurmSession, monitor: SessionMonitor, progress: vscode.Progress<{ message?: string }>, observer: PromptObserver): Promise<void> {
    logger.info(`Session ${session.name}: initiating launch`);
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

export async function stopSession(session: SlurmSession, monitor: SessionMonitor, progress: vscode.Progress<{ message?: string }>): Promise<void> {
    logger.info(`Session ${session.name}: stopping`);
    progress.report({ message: 'Stopping session...' });

    let stopError: Error | undefined;
    try {
        if (session.jobId) {
            const stopCommand = `scancel ${session.jobId}`;
            logger.info(`Session ${session.name}: sending stop command: ${stopCommand}`);
            const stopResult = await SshManager.getInstance().runRemoteCommand(session.cluster, stopCommand);
            if (stopResult.code !== 0) {
                throw new Error(`Session ${session.name}: failed to send stop command: ${stopResult.stderr}`);
            }
            logger.info(`Session ${session.name}: stop command sent successfully`);
        }
        else {
            logger.warn(`Session ${session.name}: has no job ID; marking stopped without scancel.`);
        }
        setStatus(session, 'stopped');
    }
    catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Session ${session.name}: Error while stopping:`, error);
        setStatus(session, 'failed', stopError.message);
    }

    // On failure the job may still be alive, so free only the local port and keep the refs for reattach.
    if (session.status === 'stopped') {
        try {
            await disconnectSessionFromTunnel(session);
        }
        catch (err) {
            logger.error(`Session ${session.name}: Failed to disconnect from tunnel: ${err}`);
        }
    }
    else {
        await disposeTunnelClient(session.id);
    }

    void recordSessionRun(session);
    monitor.stopMonitoring(session.id);

    if (stopError) { throw stopError; }
}

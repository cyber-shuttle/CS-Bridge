// The job runs under the user's own ssh and ~/.ssh/config; cs-plane never reaches the cluster. A launch installs
// linkspan if needed, defines the session on cs-plane under its local id, attaches it for the tunnel the
// csbridge.transport setting names, and submits a job whose linkspan dials that tunnel with its token in sbatch's
// environment, so an unexpected linkspan cannot link. A failed submit releases what cs-plane attached. Each poll takes
// cs-plane's READY as linked and leaves the job's end to sacct, since cs-plane never schedules a client's job. Stop cancels the job over ssh and always
// releases cs-plane's side.
import * as vscode from 'vscode';
import { SlurmJobStatus, SlurmSession } from '../models';
import { Logger, errMsg } from './../logger';
import { getAllSessions, setStatus, updateSession } from '../extensionStore';
import { Control, PlaneSession, toSpec } from '../control';
import { SshManager } from './sshSupport';
import { getSlurmJobStatus } from './slurmSupport';
import { buildSlurmScript, tunnelLaunch } from './slurmParse';
import { computeStatusTransition } from './sessionMachine';
import { checkSlurmAvailability, linkspanIsUpToDate, installLinkspan, submitJobToSlurm } from './slurmLaunch';

const logger = Logger.getInstance();
const TRACKED: SlurmSession['status'][] = ['queued', 'preparing', 'ready_to_connect', 'stopping'];

const sessionLine = (name: string, msg: string): string => `Session ${name}: ${msg}`;

export async function trackSessions(control: Control): Promise<void> {
    const tracked = getAllSessions().filter(s => TRACKED.includes(s.status) && s.jobId);
    if (!tracked.length) { return; }
    const plane = new Map((await control.listSessions().catch(() => [])).map(p => [p.id, p]));
    await Promise.all(tracked.map(s => track(s, plane.get(s.planeId ?? ''), control)));
}

async function track(session: SlurmSession, plane: PlaneSession | undefined, control: Control): Promise<void> {
    try {
        if (plane?.state === 'READY' && session.status !== 'stopping') {
            session.startedAt ??= Date.parse(plane.startedAt ?? plane.updatedAt);
            if (session.status !== 'ready_to_connect') { setStatus(session, 'ready_to_connect', ''); }
        }
        const { status: slurmStatus, elapsedSec } = await getSlurmJobStatus(session);

        // Anchor the wall-time countdown to Slurm's reported elapsed run-time, not the poll time.
        if (slurmStatus === SlurmJobStatus.RUNNING && !session.startedAt) {
            session.startedAt = Date.now() - elapsedSec * 1000;
            updateSession(session);
        }
        const t = computeStatusTransition(session.status, slurmStatus);
        if (t.next) { setStatus(session, t.next, t.error); }
        if (t.stopMonitoring && session.planeId) { await control.stopSession(session.planeId).catch(() => undefined); }
    }
    catch (error) {
        logger.warn(sessionLine(session.name, `cluster unreachable (will retry): ${errMsg(error)}`));
    }
}

export async function launchSession(session: SlurmSession, control: Control): Promise<void> {
    logger.info(sessionLine(session.name, `initiating launch`));
    const run = SshManager.getInstance();
    await checkSlurmAvailability(session, run, logger);
    if (!await linkspanIsUpToDate(session, run, logger)) {
        await installLinkspan(session, run, logger);
    }
    const mode = vscode.workspace.getConfiguration('csbridge').get('transport') === 'devtunnel' ? 'devtunnel' : 'websocket';
    // Created once: a restart reattaches the same cs-plane session, whose tunnel mode attach may change.
    session.planeId ??= (await control.createSession(toSpec(session))).id;
    await control.stopSession(session.planeId); // attach refuses a live session, and a lost stop would leave one
    const attachment = await control.attachSession(session.planeId, mode);
    try {
        const { args, env } = tunnelLaunch(attachment);
        session.batchScript = buildSlurmScript(session, args, attachment.port);
        await submitJobToSlurm(session, run, logger, env);
    }
    catch (err) {
        await control.stopSession(session.planeId).catch(() => undefined);
        throw err;
    }
    setStatus(session, 'queued');
}

export async function stopSession(session: SlurmSession, control: Control): Promise<void> {
    logger.info(sessionLine(session.name, `stopping`));

    let stopError: Error | undefined;
    try {
        if (session.jobId) {
            const stopCommand = `scancel ${session.jobId}`;
            logger.info(sessionLine(session.name, `sending stop command: ${stopCommand}`));
            const stopResult = await SshManager.getInstance().runRemoteCommand(session.cluster, stopCommand);
            if (stopResult.code !== 0) {
                throw new Error(`Session ${session.name}: failed to send stop command: ${stopResult.stderr}`);
            }
            logger.info(sessionLine(session.name, `stop command sent successfully`));
        }
        else {
            logger.warn(sessionLine(session.name, `has no job ID; marking stopped without scancel.`));
        }
        setStatus(session, 'stopped');
    }
    catch (error) {
        stopError = error instanceof Error ? error : new Error(String(error));
        logger.error(`Session ${session.name}: Error while stopping:`, error);
        setStatus(session, 'failed', stopError.message);
    }

    // A failed scancel still releases cs-plane's side, so the run's link token dies with it.
    await (session.planeId && control.stopSession(session.planeId).catch(err => logger.warn(sessionLine(session.name, `releasing CyberShuttle failed: ${errMsg(err)}`))));

    if (stopError) { throw stopError; }
}

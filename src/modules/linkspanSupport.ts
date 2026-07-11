import { Logger } from '../logger';
import { SlurmSession } from '../models';
import { devtunnelApiGet } from './tunnelSupport';

const logger = Logger.getInstance();

export async function checkLinkspanHealth(session: SlurmSession) {
    const { ok, status: httpStatus, body } = await devtunnelApiGet(session.connectionInfo, '/health');

    // The Dev Tunnels edge answers 200 with an HTML page once the host is gone, so require linkspan's {"status":"ok"} body.
    let status: unknown;
    try { status = (JSON.parse(body) as { status?: unknown }).status; }
    catch { /* not JSON: the edge's interstitial page */ }

    // Caller logs the failure in context (preparing-poll vs relay-live ping); don't double-log here.
    if (!ok || status !== 'ok') {
        throw new Error(`Session ${session.name}: linkspan unhealthy (status=${httpStatus}): ${body.slice(0, 200)}`);
    }
    logger.info(`Session ${session.name}: linkspan healthy`);
}

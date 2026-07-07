import { Logger } from '../logger';
import { SlurmSession } from '../models';
import { devtunnelApiUrl, devtunnelAuthHeader } from './tunnelSupport';

const logger = Logger.getInstance();

export async function checkLinkspanHealth(session: SlurmSession) {
    const resp = await fetch(devtunnelApiUrl(session.connectionInfo, '/health'), {
        method: 'GET',
        headers: {
            'X-Tunnel-Authorization': devtunnelAuthHeader(session.connectionInfo),
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(2000),
    });

    // The Dev Tunnels edge answers 200 with an HTML page once the host is gone, so require linkspan's {"status":"ok"} body.
    const body = await resp.text();
    let status: unknown;
    try { status = (JSON.parse(body) as { status?: unknown }).status; }
    catch { /* not JSON: the edge's interstitial page */ }

    if (!resp.ok || status !== 'ok') {
        logger.error(`Health check for session ${session.name} failed. API response: ${resp.status} ${resp.statusText} - ${body.slice(0, 200)}`);
        throw new Error(`Health check failed with status ${resp.status}: ${body.slice(0, 200)}`);
    }
    logger.info(`Health check for session ${session.name} succeeded.`);
}

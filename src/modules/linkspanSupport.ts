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

    if (resp.ok) {
        logger.info(`Health check for session ${session.name} succeeded.`);
    }
    else {
        const errorText = await resp.text();
        logger.error(`Health check for session ${session.name} failed. API response: ${resp.status} ${resp.statusText} - ${errorText}`);
        throw new Error(`Health check failed with status ${resp.status}: ${errorText}`);
    }
}

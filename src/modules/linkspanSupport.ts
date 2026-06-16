import { Logger } from "../logger";
import { SlurmSession } from "../models";

const logger = Logger.getInstance();

export async function checkLinkspanHealth(session: SlurmSession) {
    const healthCheckUrl = `https://${session.connectionInfo?.apiTunnelId}-${session.connectionInfo?.apiPort}.${session.connectionInfo?.region}.devtunnels.ms/api/v1/health`;
    const apiToken = `tunnel ${session.connectionInfo?.apiTunnelAccessToken}`;

    const resp = await fetch(healthCheckUrl, {
        method: 'GET',
        headers: {
            'X-Tunnel-Authorization': apiToken,
            'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(2000) // 2 seconds timeout for health check
    });

    if (resp.ok) {
        logger.info(`Health check for session ${session.name} succeeded.`);
    } else {
        const errorText = await resp.text();
        logger.error(`Health check for session ${session.name} failed. API response: ${resp.status} ${resp.statusText} - ${errorText}`);
        throw new Error(`Health check failed with status ${resp.status}: ${errorText}`);
    }
}
import { Logger } from '../logger';
import { SlurmSession } from '../models';
import { requireLinkspanJson } from './tunnelSupport';

const logger = Logger.getInstance();

export async function checkLinkspanHealth(session: SlurmSession) {
    // The Dev Tunnels edge answers 200 with an HTML page once the host is gone, so require linkspan's {"status":"ok"} body.
    await requireLinkspanJson(session, '/health', j => (j as { status?: unknown })?.status === 'ok');
    logger.info(`Session ${session.name}: linkspan healthy`);
}

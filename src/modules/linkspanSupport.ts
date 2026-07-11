import { Logger } from '../logger';
import { SessionConnectionInfo, SlurmSession } from '../models';
import { updateSession } from '../extensionStore';
import { writeSessionPrivateKey } from './sshSupport';

// linkspan's HTTP API, reached over the session's Dev Tunnel edge. `tunnelSupport` owns the Dev Tunnels
// management/relay plane (tunnel CRUD, relay client, Microsoft auth); this module owns every call to linkspan's own
// HTTP API layered on top of it. The Dev Tunnels auth token, when needed, is passed in by the caller so this module's
// dependency stays one-directional (tunnelSupport → linkspanSupport, no cycle).

const logger = Logger.getInstance();

const devtunnelApiUrl = (ci: SessionConnectionInfo | undefined, path: string): string =>
    `https://${ci?.apiTunnelId}-${ci?.apiPort}.${ci?.region}.devtunnels.ms/api/v1${path}`;

const devtunnelAuthHeader = (ci: SessionConnectionInfo | undefined): string =>
    `tunnel ${ci?.apiTunnelAccessToken}`;

const devtunnelHeaders = (ci: SessionConnectionInfo | undefined) =>
    ({ 'X-Tunnel-Authorization': devtunnelAuthHeader(ci), 'Content-Type': 'application/json' });

// linkspan HTTP over the tunnel shares one cross-region relay + a 2-CPU linkspan with live SSH traffic and every
// window's polls, so a healthy round-trip can take several seconds under load. Kept below the 5s poll interval.
const LINKSPAN_HTTP_TIMEOUT_MS = 4500;

async function devtunnelApiGet(ci: SessionConnectionInfo | undefined, path: string): Promise<{ ok: boolean; status: number; body: string }> {
    const resp = await fetch(devtunnelApiUrl(ci, path), {
        method: 'GET',
        headers: devtunnelHeaders(ci),
        signal: AbortSignal.timeout(LINKSPAN_HTTP_TIMEOUT_MS),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
}

async function devtunnelApiPost(ci: SessionConnectionInfo, sessionId: string, path: string, body: unknown, action: string): Promise<Response> {
    const resp = await fetch(devtunnelApiUrl(ci, path), {
        method: 'POST',
        headers: devtunnelHeaders(ci),
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errorText = await resp.text();
        logger.error(`${action} failed for session ${sessionId}. API response: ${resp.status} ${resp.statusText} - ${errorText}`);
        throw new Error(`${action} failed for session ${sessionId}. API response: ${resp.status} ${resp.statusText}`);
    }
    return resp;
}

// GET a linkspan endpoint and require a valid JSON body — the Dev Tunnels edge answers 200 with an HTML interstitial
// once the host is gone, so a parseable, shape-checked body (not resp.ok) is the real liveness signal.
export async function requireLinkspanJson(session: SlurmSession, path: string, valid: (json: unknown) => boolean): Promise<unknown> {
    const { ok, status, body } = await devtunnelApiGet(session.connectionInfo, path);
    let json: unknown;
    try { json = JSON.parse(body); }
    catch { /* not JSON: the edge's interstitial page */ }
    if (!ok || !valid(json)) {
        throw new Error(`Session ${session.name}: linkspan unhealthy (status=${status}): ${body.slice(0, 200)}`);
    }
    return json;
}

export async function checkLinkspanHealth(session: SlurmSession): Promise<void> {
    // The Dev Tunnels edge answers 200 with an HTML page once the host is gone, so require linkspan's {"status":"ok"} body.
    await requireLinkspanJson(session, '/health', j => (j as { status?: unknown })?.status === 'ok');
    logger.info(`Session ${session.name}: linkspan healthy`);
}

// linkspan's sshd supervisor state (GET /vscode/sessions → SessionStatus[]). linkspan binds each sshd on ":<port>"
// and ids it "s-<port>", so both fields encode the port, and the port is stable across supervisor restarts.
export interface LinkspanSshStatus {
    id: string;
    state: string; // "running" while the listener is up; "restarting"/"failed" otherwise
    active: boolean; // true only while accepting connections
    addr?: string; // ":<port>" the sshd is bound to
    restarts: number;
    last_error?: string;
}

// A JSON array is also our liveness signal (the edge serves HTML once the host is gone), so this doubles as the relay-live ping.
export async function getSshServerStatus(session: SlurmSession): Promise<LinkspanSshStatus[]> {
    return await requireLinkspanJson(session, '/vscode/sessions', Array.isArray) as LinkspanSshStatus[];
}

export const sshdPort = (s: LinkspanSshStatus): number =>
    Number(s.addr?.split(':').pop()) || Number(s.id.replace(/^s-/, '')) || 0;

// One-line render of the sshd supervisor state for the health log.
export function summarizeSshStatus(list: LinkspanSshStatus[]): string {
    if (!list.length) { return 'no sshd'; }
    return list.map(s =>
        `${s.state}${s.active ? '' : '/inactive'}${s.addr ? ` @${s.addr}` : ''}`
        + `${s.restarts ? ` restarts=${s.restarts}` : ''}${s.last_error ? ` err="${s.last_error}"` : ''}`,
    ).join(', ');
}

type LiveConnectionInfo = SessionConnectionInfo & { apiTunnelId: string; apiPort: number; apiTunnelAccessToken: string };

function requireLiveApiInfo(session: SlurmSession): LiveConnectionInfo {
    const ci = session.connectionInfo;
    if (!ci?.apiTunnelId || !ci.apiPort || !ci.apiTunnelAccessToken) {
        throw new Error(`Session ${session.id} is missing live Dev Tunnel API info; wait for status to refresh, then retry, or relaunch.`);
    }
    return ci as LiveConnectionInfo;
}

// Create a fresh sshd on the compute node (POST /vscode/sessions). Not idempotent — the caller guards re-creation.
export async function createSshServer(session: SlurmSession): Promise<void> {
    const ci = requireLiveApiInfo(session);
    logger.info(`Creating SSH server for session ${session.id}...`);

    const resp = await devtunnelApiPost(ci, session.id, '/vscode/sessions', { mount_user_home: false }, 'Create SSH server');
    const sshServerResponse = await resp.json() as { bind_port: number; password: string; id: string; private_key: string };
    logger.info(`SSH server for session ${session.id} created on port ${sshServerResponse.bind_port}.`);

    ci.sshPort = sshServerResponse.bind_port;
    ci.sshPassword = sshServerResponse.password;
    ci.sshPrivateKey = sshServerResponse.private_key;
    // Persist now so a reload at ready_to_connect can reconnect without re-fetching the key over the login node.
    writeSessionPrivateKey(session.id, sshServerResponse.private_key);
    updateSession(session);
}

// Forward the sshd port on the session's current API tunnel. The Dev Tunnels auth token is supplied by the caller
// (tunnelSupport owns MS auth), keeping this module's dependency one-directional. Idempotent on linkspan.
export async function forwardSshPortOnTunnel(session: SlurmSession, devTunnelAuthToken: string): Promise<void> {
    logger.info('Forwarding SSH port on the existing API tunnel...');
    const ci = requireLiveApiInfo(session);

    await devtunnelApiPost(ci, session.id, '/tunnels/devtunnels/forward', {
        tunnelName: ci.apiTunnelId,
        port: ci.sshPort,
        token: devTunnelAuthToken,
    }, `Forward SSH port on tunnel ${ci.apiTunnelId}`);

    ci.sshTunnelId = ci.apiTunnelId; // SSH rides the API tunnel; this is the persisted reconnect anchor
    updateSession(session);
    logger.info(`SSH port ${ci.sshPort} forwarded on tunnel ${ci.apiTunnelId} for session ${session.id}.`);
}

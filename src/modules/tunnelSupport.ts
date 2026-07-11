import { AccountInfo, SessionConnectionInfo, SlurmSession, TunnelCredential } from '../models';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import { updateSession } from '../extensionStore';
import {
    TunnelManagementHttpClient,
    ManagementApiVersions,
} from '@microsoft/dev-tunnels-management';
import {
    TunnelRelayTunnelClient,
    ConnectionStatus,
} from '@microsoft/dev-tunnels-connections';
import { TunnelAccessScopes } from '@microsoft/dev-tunnels-contracts';
import { getSessionPrivateKey, removeSshConfigEntry, writeSessionPrivateKey } from './sshSupport';
import { csHostAlias } from './sshHostsStore';
import { isLinkspanHealthy, LinkspanSshStatus, LINKSPAN_FORWARD, LINKSPAN_HEALTH, LINKSPAN_SSH_SERVERS, SshServerInfo, sshdPort } from './linkspanSupport';

const DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const DEV_TUNNELS_SCOPE = `${DEV_TUNNELS_APP_ID}/.default`;

const logger = Logger.getInstance();

const activeTunnelClients = new Map<string, TunnelRelayTunnelClient>();

function buildTunnelManagementClient(): TunnelManagementHttpClient {
    return new TunnelManagementHttpClient(
        { name: 'csbridge-vscode', version: '1.0' },
        ManagementApiVersions.Version20230927preview,
        async () => `Bearer ${await getDevTunnelAuthToken()}`,
    );
}

// --- linkspan calls over the devtunnel edge (linkspanSupport declares the endpoints) ---

const devtunnelApiUrl = (ci: SessionConnectionInfo | undefined, path: string): string =>
    `https://${ci?.apiTunnelId}-${ci?.apiPort}.${ci?.region}.devtunnels.ms/api/v1${path}`;

const devtunnelHeaders = (ci: SessionConnectionInfo | undefined) =>
    ({ 'X-Tunnel-Authorization': `tunnel ${ci?.apiTunnelAccessToken}`, 'Content-Type': 'application/json' });

// linkspan HTTP over the tunnel shares one cross-region relay + a 2-CPU linkspan with live SSH traffic and every
// window's polls, so a healthy round-trip can take several seconds under load. Kept below the 5s poll interval.
const LINKSPAN_HTTP_TIMEOUT_MS = 4500;

// GET a linkspan endpoint and require a valid JSON body — the Dev Tunnels edge answers 200 with an HTML interstitial
// once the host is gone, so a parseable, shape-checked body (not resp.ok) is the real liveness signal.
async function requireLinkspanJson(session: SlurmSession, path: string, valid: (json: unknown) => boolean): Promise<unknown> {
    const resp = await fetch(devtunnelApiUrl(session.connectionInfo, path), {
        method: 'GET', headers: devtunnelHeaders(session.connectionInfo), signal: AbortSignal.timeout(LINKSPAN_HTTP_TIMEOUT_MS),
    });
    const body = await resp.text();
    let json: unknown;
    try { json = JSON.parse(body); }
    catch { /* not JSON: the edge's interstitial page */ }
    if (!resp.ok || !valid(json)) {
        throw new Error(`Session ${session.name}: linkspan unhealthy (status=${resp.status}): ${body.slice(0, 200)}`);
    }
    return json;
}

async function devtunnelApiPost(ci: SessionConnectionInfo, sessionId: string, path: string, body: unknown, action: string): Promise<Response> {
    const resp = await fetch(devtunnelApiUrl(ci, path), { method: 'POST', headers: devtunnelHeaders(ci), body: JSON.stringify(body) });
    if (!resp.ok) {
        const errorText = await resp.text();
        logger.error(`${action} failed for session ${sessionId}. API response: ${resp.status} ${resp.statusText} - ${errorText}`);
        throw new Error(`${action} failed for session ${sessionId}. API response: ${resp.status} ${resp.statusText}`);
    }
    return resp;
}

export async function checkLinkspanHealth(session: SlurmSession): Promise<void> {
    await requireLinkspanJson(session, LINKSPAN_HEALTH, isLinkspanHealthy);
    logger.info(`Session ${session.name}: linkspan healthy`);
}

// A JSON array is also our liveness signal (the edge serves HTML once the host is gone), so this doubles as the relay-live ping.
export async function getSshServerStatus(session: SlurmSession): Promise<LinkspanSshStatus[]> {
    return await requireLinkspanJson(session, LINKSPAN_SSH_SERVERS, Array.isArray) as LinkspanSshStatus[];
}

type LiveConnectionInfo = SessionConnectionInfo & { apiTunnelId: string; apiPort: number; apiTunnelAccessToken: string };

function requireLiveApiInfo(session: SlurmSession): LiveConnectionInfo {
    const ci = session.connectionInfo;
    if (!ci?.apiTunnelId || !ci.apiPort || !ci.apiTunnelAccessToken) {
        throw new Error(`Session ${session.id} is missing live Dev Tunnel API info; wait for status to refresh, then retry, or relaunch.`);
    }
    return ci as LiveConnectionInfo;
}

async function createSshServer(session: SlurmSession): Promise<void> {
    const ci = requireLiveApiInfo(session);
    logger.info(`Creating SSH server for session ${session.id}...`);

    const resp = await devtunnelApiPost(ci, session.id, LINKSPAN_SSH_SERVERS, { mount_user_home: false }, 'Create SSH server');
    const sshServer = await resp.json() as SshServerInfo;
    logger.info(`SSH server for session ${session.id} created on port ${sshServer.bind_port}.`);

    ci.sshPort = sshServer.bind_port;
    ci.sshPassword = sshServer.password;
    ci.sshPrivateKey = sshServer.private_key;
    // Persist now so a reload at ready_to_connect can reconnect without re-fetching the key over the login node.
    writeSessionPrivateKey(session.id, sshServer.private_key);
    updateSession(session);
}

async function forwardSshPortOnTunnel(session: SlurmSession): Promise<void> {
    logger.info('Forwarding SSH port on the existing API tunnel...');
    const ci = requireLiveApiInfo(session);

    await devtunnelApiPost(ci, session.id, LINKSPAN_FORWARD, {
        tunnelName: ci.apiTunnelId,
        port: ci.sshPort,
        token: await getDevTunnelAuthToken(),
    }, `Forward SSH port on tunnel ${ci.apiTunnelId}`);

    ci.sshTunnelId = ci.apiTunnelId; // SSH rides the API tunnel; this is the persisted reconnect anchor
    updateSession(session);
    logger.info(`SSH port ${ci.sshPort} forwarded on tunnel ${ci.apiTunnelId} for session ${session.id}.`);
}

export async function ensureDevTunnel(session: SlurmSession): Promise<void> {
    const mgmt = buildTunnelManagementClient();
    const ci = session.connectionInfo ?? (session.connectionInfo = { sshPort: 0, sshTunnelId: '', region: '' });
    const opts = { tokenScopes: [TunnelAccessScopes.Connect] };

    const existing = session.tunnelId
        ? await mgmt.getTunnel({ tunnelId: session.tunnelId, clusterId: session.tunnelCluster }, opts)
        : null;
    const tunnel = existing ?? await mgmt.createTunnel(
        session.tunnelId ? { tunnelId: session.tunnelId, clusterId: session.tunnelCluster } : {}, opts);

    session.tunnelId = tunnel.tunnelId;
    session.tunnelCluster = tunnel.clusterId;
    ci.apiTunnelId = tunnel.tunnelId;
    ci.region = tunnel.clusterId ?? ci.region;
    ci.apiTunnelAccessToken = tunnel.accessTokens?.[TunnelAccessScopes.Connect] ?? ci.apiTunnelAccessToken;
    updateSession(session);
}

export async function removeDevTunnel(session: SlurmSession): Promise<void> {
    if (!session.tunnelId) { return; }
    try {
        await buildTunnelManagementClient().deleteTunnel({ tunnelId: session.tunnelId, clusterId: session.tunnelCluster });
    }
    catch (err) {
        logger.warn(`Failed to delete dev tunnel ${session.tunnelId}:`, err);
    }
    session.tunnelId = undefined;
    session.tunnelCluster = undefined;
    updateSession(session);
}

// Step 1: an sshd forwarded on the session's current API tunnel. linkspan is the source of truth for the sshd, so we
// reconcile to what it reports rather than trusting local port/forward state — self-healing a stale port after a
// linkspan restart, or a forward stranded on a re-minted tunnel. Idempotent.
export async function ensureRemoteSession(session: SlurmSession): Promise<void> {
    await ensureDevTunnel(session); // re-mints apiTunnelId (+ token) over the MS API before we forward against it
    const ci = session.connectionInfo!; // ensureDevTunnel guarantees connectionInfo

    // Reuse the sshd linkspan reports (its port is stable across restarts) as long as we still hold its key; else create
    // a fresh one — only create returns the key we SSH with. A "failed" sshd has given up, so it doesn't count as reusable.
    // Best-effort: if the probe stalls (flaky relay) but we're already forwarded on the current tunnel with a known port,
    // proceed with that rather than failing the whole connect — the reconcile is an optimization, not a gate.
    let sshd: LinkspanSshStatus | undefined;
    try { sshd = (await getSshServerStatus(session)).find(s => s.state !== 'failed'); }
    catch (err) {
        if (ci.sshTunnelId === ci.apiTunnelId && ci.sshPort) { return; }
        throw err;
    }
    const port = sshd ? sshdPort(sshd) : 0;
    if (port && (ci.sshPrivateKey ?? getSessionPrivateKey(session.id))) {
        ci.sshPort = port;
    }
    else {
        await createSshServer(session);
    }

    // forwardSshPortOnTunnel is idempotent on linkspan (already-forwarded port → no-op) and stamps sshTunnelId =
    // apiTunnelId, so this just ensures the current port rides the current tunnel.
    await forwardSshPortOnTunnel(session);
}

export function hasActiveTunnelClient(sessionId: string): boolean {
    return activeTunnelClients.has(sessionId);
}

// True while this window's relay client holds a live connection — its keepAlive already watches the link, so this is
// the authoritative liveness signal for a connected session and lets the monitor skip HTTP-pinging the same tunnel.
export function isTunnelClientConnected(sessionId: string): boolean {
    return activeTunnelClients.get(sessionId)?.connectionStatus === ConnectionStatus.Connected;
}

export async function connectSessionToTunnel(session: SlurmSession): Promise<number> {
    logger.info(`Connecting session ${session.id} to tunnel...`);

    if (!session.connectionInfo) {
        throw new Error(`Session ${session.id} does not have connection info.`);
    }

    const { sshTunnelId, sshPort, region } = session.connectionInfo;
    const mgmtClient = buildTunnelManagementClient();

    const tunnel = await mgmtClient.getTunnel(
        { tunnelId: sshTunnelId, clusterId: region },
        {
            includePorts: true,
            tokenScopes: [TunnelAccessScopes.Connect],
        },
    );

    if (!tunnel) {
        throw new Error(`Tunnel ${sshTunnelId} not found in cluster ${region}.`);
    }

    logger.info(`Fetched tunnel ${sshTunnelId}: ${tunnel.endpoints?.length ?? 0} endpoints, ${tunnel.ports?.length ?? 0} ports`);

    // Register before connecting so a re-entrant connect can't orphan the prior client and a failed connect stays disposable.
    await disposeTunnelClient(session.id);
    const client = new TunnelRelayTunnelClient(mgmtClient);
    client.acceptLocalConnectionsForForwardedPorts = true;
    // Surface relay link health: a stalled/reconnecting tunnel is otherwise invisible, and this tells contention from raw relay bandwidth.
    client.connectionStatusChanged(e => logger.info(`Tunnel ${session.id}: relay ${e.previousStatus} → ${e.status}${e.disconnectError ? ` (${e.disconnectError.message})` : ''}`));
    client.keepAliveFailed(e => logger.warn(`Tunnel ${session.id}: relay keep-alive missed ${e.count} consecutive probe(s)`));
    activeTunnelClients.set(session.id, client);

    let localPort: number;
    try {
        await client.connect(tunnel, {
            enableRetry: true,
            enableReconnect: true,
            keepAliveIntervalInSeconds: 15, // probe the upstream WebSocket so a half-open relay is detected and reconnected fast (default 0 = off)
        });
        // the sshd port is added after the host starts, so refresh before waiting for it
        try { await client.refreshPorts(); }
        catch (err) { logger.warn(`refreshPorts failed for session ${session.id}:`, err); }
        await client.waitForForwardedPort(sshPort);
        localPort = client.forwardedPorts?.find(p => p.remotePort === sshPort)?.localPort ?? sshPort;
    }
    catch (err) {
        await disposeTunnelClient(session.id);
        throw err;
    }

    session.connectionInfo!.sshTunnelForwardPort = localPort;
    logger.info(`Tunnel connected for session ${session.id}. SSH available at 127.0.0.1:${localPort}`);
    return localPort;
}

// Frees the local port only. Never deletes the remote sshd/tunnel (job-scoped, reaped by linkspan) — that would break reattach.
export async function disposeTunnelClient(sessionId: string): Promise<void> {
    const client = activeTunnelClients.get(sessionId);
    if (!client) { return; }
    try {
        await client.dispose();
        logger.info(`Tunnel relay client disposed for session ${sessionId}`);
    }
    catch (err) {
        logger.error(`Error disposing tunnel relay client for session ${sessionId}:`, err);
    }
    activeTunnelClients.delete(sessionId);
}

export async function disposeAllTunnelClients(): Promise<void> {
    await Promise.all([...activeTunnelClients.keys()].map(id => disposeTunnelClient(id)));
}

export async function disconnectSessionFromTunnel(session: SlurmSession): Promise<void> {
    await disposeTunnelClient(session.id);
    removeSshConfigEntry(session.id, csHostAlias(session.cluster, session.name));
    session.connectionInfo = undefined;
    updateSession(session);
    logger.info(`Session ${session.id} disconnected from tunnel.`);
}

export async function getDevTunnelCredentials(): Promise<TunnelCredential> {
    const token = await getDevTunnelAuthToken();
    logger.info('Obtained Dev Tunnels auth token successfully.');

    return {
        provider: 'devtunnel',
        authToken: token,
        serverUrl: 'https://devtunnels.microsoft.com',
    };
}

function getMicrosoftSession(options: vscode.AuthenticationGetSessionOptions & { createIfNone: true }): Thenable<vscode.AuthenticationSession>;
function getMicrosoftSession(options: vscode.AuthenticationGetSessionOptions): Thenable<vscode.AuthenticationSession | undefined>;
function getMicrosoftSession(options: vscode.AuthenticationGetSessionOptions) {
    return vscode.authentication.getSession('microsoft', [DEV_TUNNELS_SCOPE], options);
}

async function getDevTunnelAuthToken(): Promise<string> {
    try {
        const session = await getMicrosoftSession({ createIfNone: true });
        return session?.accessToken || '';
    }
    catch (err) {
        logger.error('Failed to get Dev Tunnels auth token:', err);
        throw new Error('Dev Tunnels authentication is required. Please sign in to your Microsoft account.');
    }
}

export async function switchDevTunnelAccount(): Promise<void> {
    const session = await getMicrosoftSession({ clearSessionPreference: true, createIfNone: true });
    logger.info(`Dev Tunnels: switched to ${session.account.label}`);
}

export async function getMicrosoftAccountInfo(): Promise<AccountInfo> {
    try {
        const session = await getMicrosoftSession({ silent: true });
        return { label: session?.account.label ?? null };
    }
    catch {
        return { label: null };
    }
}

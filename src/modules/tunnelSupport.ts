import { AccountInfo, SlurmSession, TunnelCredential } from '../models';
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
import { getSessionPrivateKey, removeSshConfigEntry } from './sshSupport';
import { csHostAlias } from './sshHostsStore';
import { createSshServer, forwardSshPortOnTunnel, getSshServerStatus, LinkspanSshStatus, sshdPort } from './linkspanSupport';

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
    await forwardSshPortOnTunnel(session, await getDevTunnelAuthToken());
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

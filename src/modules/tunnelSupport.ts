import { AccountInfo, SlurmSession } from '../models';
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
import { createSessionKeyPair, hasSessionKey, removeSshConfigEntry } from './sshSupport';
import { csHostAlias } from './sshHostsStore';
import { createSshServer, getSshServers, LinkspanSshStatus, sshdPort } from './linkspanSupport';

const DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const DEV_TUNNELS_SCOPE = `${DEV_TUNNELS_APP_ID}/.default`;
// Consecutive 15s keep-alive misses (~1 min of dead relay) before we rebuild a half-open tunnel the SDK won't self-heal.
const RELAY_RECONNECT_AFTER_MISSES = 4;

const logger = Logger.getInstance();

const activeTunnelClients = new Map<string, TunnelRelayTunnelClient>();

function buildTunnelManagementClient(): TunnelManagementHttpClient {
    return new TunnelManagementHttpClient(
        { name: 'csbridge-vscode', version: '1.0' },
        ManagementApiVersions.Version20230927preview,
        async () => `Bearer ${await getDevTunnelAuthToken()}`,
    );
}

// The base URL + auth headers devtunnel mandates for reaching linkspan's API on this session's tunnel. linkspanSupport
// does the calling; the two compose at the caller.
export function linkspanEndpoint(session: SlurmSession): { baseUrl: string; headers: Record<string, string> } {
    const ci = session.connectionInfo;
    return {
        baseUrl: `https://${ci?.apiTunnelId}-${ci?.apiPort}.${ci?.region}.devtunnels.ms/api/v1`,
        headers: { 'X-Tunnel-Authorization': `tunnel ${ci?.apiTunnelAccessToken}` },
    };
}

// Makes the tunnel carry apiPort plus any extra ports, and returns the relay token: we keep the Entra bearer local
// and register every port ourselves, so the node only ever holds a token scoped to hosting this one tunnel.
export async function ensureDevTunnel(session: SlurmSession, ...ports: number[]): Promise<string> {
    const mgmt = buildTunnelManagementClient();
    const ci = session.connectionInfo ?? (session.connectionInfo = { sshPort: 0, sshTunnelId: '', region: '' });
    const opts = { includePorts: true, tokenScopes: [TunnelAccessScopes.Host, TunnelAccessScopes.Connect] };

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

    // Nothing reaches the allocation on a port the tunnel does not carry, and a failure here is the session's failure.
    for (const portNumber of [ci.apiPort, ...ports]) {
        if (!portNumber || tunnel.ports?.some(p => p.portNumber === portNumber)) { continue; }
        await mgmt.createTunnelPort(tunnel, { portNumber, protocol: 'auto' }, { tokenScopes: [TunnelAccessScopes.Host] });
    }
    const hostToken = tunnel.accessTokens?.[TunnelAccessScopes.Host];
    if (!hostToken) { throw new Error('Dev Tunnel did not return a host-scoped access token.'); }
    return hostToken;
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
    await ensureDevTunnel(session); // re-mints apiTunnelId (+ token) over the MS API before we publish against it
    const ci = session.connectionInfo!; // ensureDevTunnel guarantees connectionInfo
    const { baseUrl, headers } = linkspanEndpoint(session);

    // Reuse the sshd linkspan reports (its port is stable across restarts) as long as we still hold its key; else create
    // a fresh one — only create returns the key we SSH with. A "failed" sshd has given up, so it doesn't count as reusable.
    // Best-effort: if the probe stalls (flaky relay) but we're already forwarded on the current tunnel with a known port,
    // proceed with that rather than failing the whole connect — the reconcile is an optimization, not a gate.
    let sshd: LinkspanSshStatus | undefined;
    try { sshd = (await getSshServers(baseUrl, headers)).find(s => s.state !== 'failed'); }
    catch (err) {
        if (ci.sshTunnelId === ci.apiTunnelId && ci.sshPort) { return; }
        throw err;
    }
    const port = sshd ? sshdPort(sshd) : 0;
    if (port && hasSessionKey(session.id)) {
        ci.sshPort = port;
    }
    else {
        const created = await createSshServer(baseUrl, headers, createSessionKeyPair(session.id));
        logger.info(`SSH server for session ${session.id} created on port ${created.bind_port}.`);
        ci.sshPort = created.bind_port;
        updateSession(session);
    }

    await ensureDevTunnel(session, ci.sshPort); // the tunnel must carry the sshd port before ssh is pointed at it
    ci.sshTunnelId = ci.apiTunnelId!;
    updateSession(session);
    logger.info(`SSH port ${ci.sshPort} published on tunnel ${ci.apiTunnelId} for session ${session.id}.`);
}

export function hasActiveTunnelClient(sessionId: string): boolean {
    return activeTunnelClients.has(sessionId);
}

// True while this window's relay client holds a live connection — its keepAlive already watches the link, so this is
// the authoritative liveness signal for a connected session and lets the monitor skip HTTP-pinging the same tunnel.
export function isTunnelClientConnected(sessionId: string): boolean {
    return activeTunnelClients.get(sessionId)?.connectionStatus === ConnectionStatus.Connected;
}

export async function connectSessionToTunnel(session: SlurmSession, onRelayLost: () => void): Promise<number> {
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
    client.keepAliveFailed((e) => {
        logger.warn(`Tunnel ${session.id}: relay keep-alive missed ${e.count} consecutive probe(s)`);
        // A half-open relay stays "Connected", so the SDK's enableReconnect never fires; rebuild once misses cross the
        // bar. Fires once — the rebuild disposes this client, ending its events.
        if (e.count === RELAY_RECONNECT_AFTER_MISSES) { onRelayLost(); }
    });
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
    await removeSshConfigEntry(session.id, csHostAlias(session.cluster, session.name));
    session.connectionInfo = undefined;
    updateSession(session);
    logger.info(`Session ${session.id} disconnected from tunnel.`);
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

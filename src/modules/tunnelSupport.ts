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
} from '@microsoft/dev-tunnels-connections';
import { TunnelAccessScopes } from '@microsoft/dev-tunnels-contracts';
import { removeSshConfigEntry, writeSessionPrivateKey } from './sshSupport';

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

export const devtunnelApiUrl = (ci: SessionConnectionInfo | undefined, path: string): string =>
    `https://${ci?.apiTunnelId}-${ci?.apiPort}.${ci?.region}.devtunnels.ms/api/v1${path}`;

export const devtunnelAuthHeader = (ci: SessionConnectionInfo | undefined): string =>
    `tunnel ${ci?.apiTunnelAccessToken}`;

type LiveConnectionInfo = SessionConnectionInfo & { apiTunnelId: string; apiPort: number; apiTunnelAccessToken: string };

function requireLiveApiInfo(session: SlurmSession): LiveConnectionInfo {
    const ci = session.connectionInfo;
    if (!ci?.apiTunnelId || !ci.apiPort || !ci.apiTunnelAccessToken) {
        throw new Error(`Session ${session.id} is missing live Dev Tunnel API info; wait for status to refresh, then retry, or relaunch.`);
    }
    return ci as LiveConnectionInfo;
}

async function devtunnelApiPost(ci: SessionConnectionInfo, sessionId: string, path: string, body: unknown, action: string): Promise<Response> {
    const resp = await fetch(devtunnelApiUrl(ci, path), {
        method: 'POST',
        headers: { 'X-Tunnel-Authorization': devtunnelAuthHeader(ci), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errorText = await resp.text();
        logger.error(`${action} failed for session ${sessionId}. API response: ${resp.status} ${resp.statusText} - ${errorText}`);
        throw new Error(`${action} failed for session ${sessionId}. API response: ${resp.status} ${resp.statusText}`);
    }
    return resp;
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

async function createSshServer(session: SlurmSession): Promise<void> {
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

async function forwardSshPortOnTunnel(session: SlurmSession): Promise<void> {
    logger.info('Forwarding SSH port on the existing API tunnel...');
    const ci = requireLiveApiInfo(session);

    await devtunnelApiPost(ci, session.id, '/tunnels/devtunnels/forward', {
        tunnelName: ci.apiTunnelId,
        port: ci.sshPort,
        token: await getDevTunnelAuthToken(),
    }, `Forward SSH port on tunnel ${ci.apiTunnelId}`);

    ci.sshTunnelId = ci.apiTunnelId; // SSH rides the API tunnel; this is the persisted reconnect anchor
    updateSession(session);
    logger.info(`SSH port ${ci.sshPort} forwarded on tunnel ${ci.apiTunnelId} for session ${session.id}.`);
}

// Step 1: remote sshd up + its port exposed on a Dev Tunnel. Idempotent.
export async function ensureRemoteSession(session: SlurmSession): Promise<void> {
    // First, so reattach re-mints apiTunnelId+token over the MS API (no login-node SSH) before the early-return.
    await ensureDevTunnel(session);
    if (session.connectionInfo?.sshTunnelId) { return; }
    // Reuse an sshd a prior attempt created; linkspan's create isn't idempotent and would leak one.
    if (!session.connectionInfo?.sshPort) {
        await createSshServer(session);
    }
    await forwardSshPortOnTunnel(session);
}

export function hasActiveTunnelClient(sessionId: string): boolean {
    return activeTunnelClients.has(sessionId);
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
    removeSshConfigEntry(session.id, `cshost-${session.id}`);
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

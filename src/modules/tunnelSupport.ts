import { AccountInfo, SlurmSession, TunnelCredential } from "../models";
import * as vscode from 'vscode';
import * as net from 'net';
import { Logger } from '../logger';
import { updateSession } from "../extensionStore";
import {
    TunnelManagementHttpClient,
    ManagementApiVersions,
} from "@microsoft/dev-tunnels-management";
import {
    TunnelRelayTunnelClient,
} from "@microsoft/dev-tunnels-connections";
import { TunnelAccessScopes, Tunnel } from "@microsoft/dev-tunnels-contracts";
import { clearSSHConfigEntry, writeSessionPrivateKey } from "./sshSupport";


const DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const DEV_TUNNELS_SCOPE = `${DEV_TUNNELS_APP_ID}/.default`;

const logger = Logger.getInstance();

/** Active tunnel relay clients, keyed by session ID, so they can be disconnected later. */
const activeTunnelClients = new Map<string, TunnelRelayTunnelClient>();

function buildTunnelManagementClient(): TunnelManagementHttpClient {
    return new TunnelManagementHttpClient(
        { name: 'csbridge-vscode', version: '1.0' },
        ManagementApiVersions.Version20230927preview,
        async () => `Bearer ${await getDevTunnelAuthToken()}`,
    );
}

// cs-bridge-owned Dev Tunnel: create or resolve it via the SDK and hydrate the API-tunnel refs.
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

export async function deleteSessionDevTunnel(session: SlurmSession): Promise<void> {
    if (!session.tunnelId) { return; }
    try {
        await buildTunnelManagementClient().deleteTunnel({ tunnelId: session.tunnelId, clusterId: session.tunnelCluster });
    } catch (err) {
        logger.warn(`Failed to delete dev tunnel ${session.tunnelId}:`, err);
    }
    session.tunnelId = undefined;
    session.tunnelCluster = undefined;
    updateSession(session);
}

export async function createSSHServerForSession(session: SlurmSession): Promise<void> {

    if (!session.connectionInfo) {
        logger.error(`Session ${session.id} does not have connection info. Cannot create SSH server.`);
        throw new Error(`Session ${session.id} does not have connection info. Cannot create SSH server.`);
    }
    // api* aren't persisted across reload; fail clearly instead of POSTing a malformed URL.
    if (!session.connectionInfo.apiTunnelId || !session.connectionInfo.apiPort || !session.connectionInfo.apiTunnelAccessToken) {
        throw new Error(`Session ${session.id} is missing live Dev Tunnel API info; cannot create the SSH server. Wait for status to refresh, then retry, or relaunch.`);
    }
    // Placeholder for creating an SSH server and returning the local port it's listening on
    logger.info(`Creating SSH server for session ${session.id}...`);
    // Sample url https://linkspan-tunnel-1774674947651937316-39685.use2.devtunnels.ms/api/v1/vscode/sessions
    const baseAPIUrl = `https://${session.connectionInfo?.apiTunnelId}-${session.connectionInfo?.apiPort}.${session.connectionInfo?.region}.devtunnels.ms/api/v1`;
    const apiToken = `tunnel ${session.connectionInfo?.apiTunnelAccessToken}`;

    // send a post request to the API server to create the SSH server
    const resp = await fetch(`${baseAPIUrl}/vscode/sessions`, {
        method: 'POST',
        headers: {
            'X-Tunnel-Authorization': apiToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            "mount_user_home": false,
        })
    });

    if (!resp.ok) {
        const errorText = await resp.text();
        logger.error(`Failed to create SSH server for session ${session.id}. API response: ${resp.status} ${resp.statusText} - ${errorText}`);
        throw new Error(`Failed to create SSH server for session ${session.id}. API response: ${resp.status} ${resp.statusText}`);
    }

    const respData = await resp.json() as { bind_port: number; password: string; id: string, private_key: string };
    logger.info(`SSH server for session ${session.id} created on port ${respData.bind_port}.`);
    session.connectionInfo!.sshPort = respData.bind_port;
    session.connectionInfo!.sshPassword = respData.password;
    session.connectionInfo!.sshPrivateKey = respData.private_key;
    // Persist the key to disk now (Step 1) so a reload at ready_to_connect can reconnect without
    // re-fetching it over the login node.
    writeSessionPrivateKey(session.id, respData.private_key);
    updateSession(session);
}

export async function forwardSSHPortOnTunnel(session: SlurmSession): Promise<void> {
    logger.info('Forwarding SSH port on the existing API tunnel...');

    const ci = session.connectionInfo;
    if (!ci) {
        throw new Error(`Session ${session.id} does not have connection info. Cannot forward SSH port.`);
    }
    if (!ci.apiTunnelId || !ci.apiPort || !ci.apiTunnelAccessToken) {
        throw new Error(`Session ${session.id} is missing live Dev Tunnel API info; cannot forward the SSH port. Wait for status to refresh, then retry, or relaunch.`);
    }

    const baseAPIUrl = `https://${ci.apiTunnelId}-${ci.apiPort}.${ci.region}.devtunnels.ms/api/v1`;
    const apiToken = `tunnel ${ci.apiTunnelAccessToken}`;

    const forwardResp = await fetch(`${baseAPIUrl}/tunnels/devtunnels/forward`, {
        method: 'POST',
        headers: {
            'X-Tunnel-Authorization': apiToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            tunnelName: ci.apiTunnelId,
            port: ci.sshPort,
            token: await getDevTunnelAuthToken()
        })
    });

    if (!forwardResp.ok) {
        const errorText = await forwardResp.text();
        logger.error(`Failed to forward SSH port on tunnel ${ci.apiTunnelId} in session ${session.id}. API response: ${forwardResp.status} ${forwardResp.statusText} - ${errorText}`);
        throw new Error(`Failed to forward SSH port on tunnel ${ci.apiTunnelId} in session ${session.id}. API response: ${forwardResp.status} ${forwardResp.statusText}`);
    }

    ci.sshTunnelId = ci.apiTunnelId; // SSH rides the API tunnel; this is the persisted reconnect anchor
    updateSession(session);
    logger.info(`SSH port ${ci.sshPort} forwarded on tunnel ${ci.apiTunnelId} for session ${session.id}.`);
}

// Step 1: ensure the remote sshd exists and its port is exposed on a Dev Tunnel. Idempotent.
export async function ensureRemoteSession(session: SlurmSession): Promise<void> {
    if (session.connectionInfo?.sshTunnelId) { return; }
    await ensureDevTunnel(session);
    // Reuse an sshd a prior attempt already created (linkspan's create isn't idempotent, so re-creating would leak one).
    if (!session.connectionInfo?.sshPort) {
        await createSSHServerForSession(session);
    }
    await forwardSSHPortOnTunnel(session);
}

export async function connectSessionToSSHTunnel(session: SlurmSession): Promise<number> {
    logger.info(`Connecting session ${session.id} to tunnel...`);

    if (!session.connectionInfo) {
        throw new Error(`Session ${session.id} does not have connection info.`);
    }

    const { sshTunnelId, sshPort, region } = session.connectionInfo;

    // Create management client with AAD user token for auth
    const mgmtClient = buildTunnelManagementClient();

    // Fetch the full tunnel object (with endpoints + ports) from the service
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
    await disposeSessionTunnelClient(session.id);
    const client = new TunnelRelayTunnelClient(mgmtClient);
    client.acceptLocalConnectionsForForwardedPorts = true;
    activeTunnelClients.set(session.id, client);

    let localPort: number;
    try {
        await client.connect(tunnel, {
            enableRetry: true,
            enableReconnect: true,
        });
        // pick up the sshd port added after the host started
        try { await client.refreshPorts(); } catch (err) { logger.warn(`refreshPorts failed for session ${session.id}:`, err); }
        await client.waitForForwardedPort(sshPort);
        localPort = client.forwardedPorts?.find((p) => p.remotePort === sshPort)?.localPort ?? sshPort;
    } catch (err) {
        await disposeSessionTunnelClient(session.id);
        throw err;
    }

    // Record the (ephemeral) forward port; the caller owns the status transition.
    session.connectionInfo!.sshTunnelForwardPort = localPort;
    logger.info(`Tunnel connected for session ${session.id}. SSH available at 127.0.0.1:${localPort}`);
    return localPort;
}

/**
 * Dispose the in-process relay client (frees the local port). Never deletes the remote sshd/tunnel:
 * those are job-scoped and reaped by linkspan, and deleting them would break reattach. No-op if absent.
 */
export async function disposeSessionTunnelClient(sessionId: string): Promise<void> {
    const client = activeTunnelClients.get(sessionId);
    if (!client) { return; }
    try {
        await client.dispose();
        logger.info(`Tunnel relay client disposed for session ${sessionId}`);
    } catch (err) {
        logger.error(`Error disposing tunnel relay client for session ${sessionId}:`, err);
    }
    activeTunnelClients.delete(sessionId);
}

/** Dispose every relay client this window holds (e.g. on extension deactivate / window close). */
export async function disposeAllTunnelClients(): Promise<void> {
    await Promise.all([...activeTunnelClients.keys()].map(id => disposeSessionTunnelClient(id)));
}

export async function disconnectSessionFromTunnel(session: SlurmSession): Promise<void> {
    await disposeSessionTunnelClient(session.id);
    clearSSHConfigEntry(session.id, `cshost-${session.id}`);
    session.connectionInfo = undefined;
    updateSession(session); // persist the cleared refs
    logger.info(`Session ${session.id} disconnected from tunnel.`);
}

export async function getDevTunnelCredentials(): Promise<TunnelCredential> {
    // Placeholder for fetching credentials from local storage or configuration
    const token = await getDevTunnelAuthToken();
    logger.info('Obtained Dev Tunnels auth token successfully.');

    return {
        provider: 'devtunnel',
        authToken: token,
        serverUrl: 'https://devtunnels.microsoft.com'
    };
}

export async function getFrpTunnelCredentials(): Promise<TunnelCredential> {
    // Placeholder for fetching credentials from local storage or configuration
    return {
        provider: 'frp',
        authToken: 'example-frp-auth-token',
        serverUrl: 'https://frp-tunnel-server.com'
    };
}

export async function getDevTunnelAuthToken(): Promise<string> {
    try {
        const session = await vscode.authentication.getSession(
            'microsoft',
            [DEV_TUNNELS_SCOPE],
            { createIfNone: true },
        );
        return session?.accessToken || '';
    } catch (err) {
        logger.error('Failed to get Dev Tunnels auth token:', err);
        throw new Error('Dev Tunnels authentication is required. Please sign in to your Microsoft account.');
    }
}

export async function switchDevTunnelAccount(): Promise<void> {
    try {
        const session = await vscode.authentication.getSession(
            'microsoft',
            [DEV_TUNNELS_SCOPE],
            { clearSessionPreference: true, createIfNone: true },
        );
        logger.info(`Dev Tunnels: switched to ${session.account.label}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${err.message}`);
    }
}

export async function getMicrosoftAccountInfo(): Promise<AccountInfo> {
    try {
        const session = await vscode.authentication.getSession(
            'microsoft',
            [DEV_TUNNELS_SCOPE],
            { silent: true },
        );
        return { label: session?.account.label ?? null };
    } catch {
        return { label: null };
    }
}

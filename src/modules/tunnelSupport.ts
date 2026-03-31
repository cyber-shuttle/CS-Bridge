import { SlurmSession, TunnelCredential } from "../models";
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
import { TunnelAccessScopes } from "@microsoft/dev-tunnels-contracts";


const DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
const DEV_TUNNELS_SCOPE = `${DEV_TUNNELS_APP_ID}/.default`;

const logger = Logger.getInstance();

export async function createSSHServerForSessionOverTunnel(session: SlurmSession): Promise<void> {

    if (!session.connectionInfo) {
        logger.error(`Session ${session.id} does not have connection info. Cannot create SSH server.`);
        throw new Error(`Session ${session.id} does not have connection info. Cannot create SSH server.`);
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

    // {"id":"s-36327","bind_port":36327,"password":"LSqTAUXEloSRwHB8"}
    const respData = await resp.json() as { bind_port: number; password: string; id: string };
    logger.info(`SSH server for session ${session.id} created successfully. Data: ${JSON.stringify(respData)}`);
    const sshPort = respData.bind_port;
    session.connectionInfo!.sshPort = sshPort;
    session.connectionInfo!.sshPassword = respData.password;
    updateSession(session);

    logger.info('Adding ssh port for existing tunnel connection...');

    // We create a new dev tunnel not to disrupt existing tunnel as it is required for API
    const forwardResp = await fetch(`${baseAPIUrl}/tunnels/devtunnels`, {
        method: 'POST',
        headers: {
            'X-Tunnel-Authorization': apiToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            "tunnelName": "ssh-tunnel-" + session.id,
            "open_ports": [sshPort],
            "expiration": "1d",
            "authToken": await getDevTunnelAuthToken() // need to use the user auth token for this API call
        })
    });

    if (!forwardResp.ok) {
        const errorText = await forwardResp.text();
        logger.error(`Failed to add ssh port to tunnel ${session.connectionInfo?.apiTunnelId} in session ${session.id}. API response: ${forwardResp.status} ${forwardResp.statusText} - ${errorText}`);
        throw new Error(`Failed to add ssh port to tunnel ${session.connectionInfo?.apiTunnelId} in session ${session.id}. API response: ${forwardResp.status} ${forwardResp.statusText}`);
    }

    // {"id":"s-36327","bind_port":36327,"password":"LSqTAUXEloSRwHB8"}
    const forwardRespData = await forwardResp.json() as { tunnelName: string; tunnelID: string, };
    session.connectionInfo!.sshTunnelId = forwardRespData.tunnelID;
    updateSession(session);
    logger.info(`SSH server forward for session ${session.id} created successfully. Data: ${JSON.stringify(forwardRespData)}`);

    // Finally do the port forwarding connection to the Dev Tunnel so that the SSH server is accessible
    connectSessionToTunnel(session)
        .then(localPort => {
            logger.info(`Session ${session.id} connected to tunnel successfully. Local SSH port: ${localPort}`);

        })
        .catch(err => {
            logger.error(`Failed to connect session ${session.id} to tunnel after creating SSH server:`, err);
        });

    // 
    // Update the ssh config file, clean up old entries if necessary
    // Use ms remote connection URI format: ssh://user@hostname:port
}

export async function connectSessionToTunnel(session: SlurmSession): Promise<number> {
    logger.info(`Connecting session ${session.id} to tunnel...`);

    if (!session.connectionInfo) {
        throw new Error(`Session ${session.id} does not have connection info.`);
    }

    const { sshTunnelId, sshPort, region } = session.connectionInfo;

    // Create management client with AAD user token for auth
    const mgmtClient = new TunnelManagementHttpClient(
        { name: 'cybershuttle-vscode', version: '1.0' },
        ManagementApiVersions.Version20230927preview,
        async () => {
            const token = await getDevTunnelAuthToken();
            return `Bearer ${token}`;
        },
    );

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

    // Create relay client and connect
    const client = new TunnelRelayTunnelClient(mgmtClient);
    client.acceptLocalConnectionsForForwardedPorts = true;

    await client.connect(tunnel, {
        enableRetry: true,
        enableReconnect: true,
    });

    // Wait for the SSH port to become available
    logger.info(`Waiting for forwarded SSH port ${sshPort}...`);
    await client.waitForForwardedPort(sshPort);

    // Read the local port the SDK bound for the forwarded port
    const localPort = client.forwardedPorts?.find((p) => p.remotePort === sshPort)?.localPort ?? sshPort;
    session.connectionInfo!.sshTunnelForwardPort = localPort;
    session.status = 'connected';
    updateSession(session);

    logger.info(`Tunnel connected for session ${session.id}. SSH available at 127.0.0.1:${localPort}`);
    return localPort;
}

export async function getDevTunnelCredentials(): Promise<TunnelCredential> {
    // Placeholder for fetching credentials from local storage or configuration
    const token = await getDevTunnelAuthToken();
    logger.info('Obtained Dev Tunnels auth token successfully. Token ' + token);

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
            { clearSessionPreference: true, createIfNone: true },
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
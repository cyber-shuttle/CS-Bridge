import { Logger } from "../logger";
import { SlurmSession } from "../models";

const logger = Logger.getInstance();

/**
 * Generate the linkspan workflow YAML for a given tunnel name.
 * Uses provider-agnostic tunnel.create / tunnel.connect actions.
 */
export function generateLinkspanWorkflow(
    tunnelName: string,
    provider: string,
    serverUrl?: string): string {
    const serverUrlLine = serverUrl ? `\n      server_url: "${serverUrl}"` : '';
    const steps: string[] = [
        `name: "cs-bridge-hpc-setup"`,
        ``,
        `steps:`,
        `  - action: "tunnel.create"`,
        `    name: "Create remote tunnel"`,
        `    params:`,
        `      provider: "${provider}"`,
        `      tunnel_name: "${tunnelName}"`,
        `      expiration: "1d"`,
        `      auth_token: "{{.TunnelAuthToken}}"${serverUrlLine}`,
        `      server_port: "{{.ServerPort}}"`,
        `      ssh_port: "{{.SshPort}}"`,
        `      log_port: "{{.LogPort}}"`,
        `    outputs:`,
        `      tunnel_id: "tunnel_id"`,
        `      connection_url: "tunnel_url"`,
        `      token: "tunnel_token"`,
        `      ssh_port: "ssh_port"`,
        `      log_port: "log_port"`,
    ];

    return steps.join('\n');
}


export async function checkLinkspanHealth(session: SlurmSession) {
    const healthCheckUrl = `https://${session.connectionInfo?.apiTunnelId}-${session.connectionInfo?.apiPort}.${session.connectionInfo?.region}.devtunnels.ms/api/v1/health`;
    const apiToken = `tunnel ${session.connectionInfo?.apiTunnelAccessToken}`;

    // send a get request to the API server to check the health
    const resp = await fetch(`${healthCheckUrl}`, {
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
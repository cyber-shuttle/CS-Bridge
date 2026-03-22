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
import { SshHost } from "../models";
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
* Parse SSH config file and extract host entries
*/
export function getSshHostsFromConfig(): SshHost[] {
    const hosts: SshHost[] = [];
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');

    try {
        if (!fs.existsSync(sshConfigPath)) {
            return hosts;
        }

        const configContent = fs.readFileSync(sshConfigPath, 'utf-8');
        const lines = configContent.split('\n');

        let currentHost: SshHost | null = null;

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip comments and empty lines
            if (trimmed.startsWith('#') || trimmed === '') {
                continue;
            }

            const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
            if (hostMatch) {
                // Save previous host if exists
                if (currentHost) {
                    hosts.push(currentHost);
                }
                // Start new host (skip wildcards)
                const hostName = hostMatch[1].trim();
                if (!hostName.includes('*') && !hostName.includes('?')
                    && !hostName.startsWith('cs-session-') && !hostName.startsWith('cs-tunnel-')) {
                    currentHost = { name: hostName };
                } else {
                    currentHost = null;
                }
                continue;
            }

            if (currentHost) {
                const hostnameMatch = trimmed.match(/^HostName\s+(.+)$/i);
                if (hostnameMatch) {
                    currentHost.hostname = hostnameMatch[1].trim();
                }

                const userMatch = trimmed.match(/^User\s+(.+)$/i);
                if (userMatch) {
                    currentHost.user = userMatch[1].trim();
                }
            }
        }

        // Don't forget the last host
        if (currentHost) {
            hosts.push(currentHost);
        }
    } catch (err) {
        console.error('Error reading SSH config:', err);
    }

    return hosts;
}
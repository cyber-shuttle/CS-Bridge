import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, LineType } from 'ssh-config';
import { SshHost } from '../models';
import { SshConfigEntry } from './sshCommandParser';

export const USER_SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
export const SYSTEM_SSH_CONFIG_PATH = process.platform === 'win32'
    ? path.join(process.env.ALLUSERSPROFILE || process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh', 'ssh_config')
    : '/etc/ssh/ssh_config';

// SSH client directives that let a session ride out last-mile/relay stalls instead of dropping.
export const SSH_RESILIENCE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
    ['ServerAliveInterval', '15'],
    ['ServerAliveCountMax', '20'],
    ['TCPKeepAlive', 'yes'],
    ['Compression', 'no'],
    ['ConnectTimeout', '30'],
    ['IPQoS', 'cs0'],
];

// Per-session cshost block appended to ~/.cybershuttle/ssh_config (4-space indent matches removeSSHConfigEntry).
export function buildSessionSshConfigBlock(
    sessionId: string,
    hostAlias: string,
    hostname: string,
    port: number,
    user: string,
    identityFile: string,
): string {
    return [
        ``,
        `# CS-Bridge auto-generated for session ${sessionId}`,
        `Host ${hostAlias}`,
        `    HostName ${hostname}`,
        `    Port ${port}`,
        `    User ${user}`,
        `    StrictHostKeyChecking no`,
        `    UserKnownHostsFile /dev/null`,
        `    IdentityFile ${identityFile}`,
        ...SSH_RESILIENCE_OPTIONS.map(([key, value]) => `    ${key} ${value}`),
    ].join('\n');
}

// ssh-config returns multi-token directives (ProxyCommand, SendEnv, …) as arrays of token objects; flatten to text.
const directiveText = (value: any): string =>
    Array.isArray(value) ? value.map((t: { val: string }) => t.val).join(' ') : value;

export function parseHostsFromConfigText(text: string): SshHost[] {
    const config = parse(text);
    const hosts: SshHost[] = [];
    for (const line of config) {
        if (line.type !== LineType.DIRECTIVE) { continue; }
        // Keep Host sections only: they carry a `config` array, Match sections also carry `criteria`.
        if (!('config' in line) || 'criteria' in line) { continue; }
        const section = line as any;
        if (section.param !== 'Host') { continue; }
        const raw = Array.isArray(section.value) ? section.value[0] : section.value;
        const alias = typeof raw === 'string' ? raw.trim().split(/\s+/)[0] : '';
        if (!alias || alias.includes('*') || alias.includes('?')) { continue; }
        const host: SshHost = { name: alias };
        const args: string[] = [];
        for (const child of section.config) {
            if (child.type !== LineType.DIRECTIVE) { continue; }
            const value = directiveText(child.value);
            if (child.param === 'HostName') { host.hostname = value; }
            else if (child.param === 'User') { host.user = value; }
            else { args.push(`${child.param} ${value}`); }
        }
        if (args.length) { host.args = args; }
        hosts.push(host);
    }
    return hosts;
}

export function addHostToConfigText(text: string, entry: SshConfigEntry): string {
    const config = parse(text);
    config.remove({ Host: entry.Host }); // replace-on-readd: clean recreate, no duplicates
    config.prepend(entry, true);         // top of file, after any Include lines
    return config.toString();
}

export function removeHostFromConfigText(text: string, name: string): string {
    const config = parse(text);
    config.remove({ Host: name });
    return config.toString();
}

// Merge host lists in priority order; the first occurrence of each name wins.
export function mergeHostsByPriority(...lists: SshHost[][]): SshHost[] {
    const seen = new Set<string>();
    const result: SshHost[] = [];
    for (const list of lists) {
        for (const host of list) {
            if (seen.has(host.name)) { continue; }
            seen.add(host.name);
            result.push(host);
        }
    }
    return result;
}

export function addHostToConfigFile(filePath: string, entry: SshConfigEntry): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    fs.writeFileSync(filePath, addHostToConfigText(text, entry), { mode: 0o600 });
}

export function removeHostFromConfigFile(filePath: string, name: string): void {
    if (!fs.existsSync(filePath)) { return; }
    const text = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(filePath, removeHostFromConfigText(text, name), { mode: 0o600 });
}

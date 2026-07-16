import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, LineType } from 'ssh-config';
import { SshHost } from '../models';
import { SshConfigEntry } from './sshCommandParser';
import { updateTextFile } from './fsSupport';

export const USER_SSH_CONFIG_PATH = path.join(os.homedir(), '.ssh', 'config');
export const SYSTEM_SSH_CONFIG_PATH = process.platform === 'win32'
    ? path.join(process.env.ALLUSERSPROFILE || process.env.PROGRAMDATA || 'C:\\ProgramData', 'ssh', 'ssh_config')
    : '/etc/ssh/ssh_config';

// SSH client directives that let a session ride out brief relay stalls, but give up within ~45s (15×3) on a
// dead-ended link so a replacement ssh -D doesn't overlap the old one and re-saturate the relay.
export const SSH_RESILIENCE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
    ['ServerAliveInterval', '15'],
    ['ServerAliveCountMax', '3'],
    ['TCPKeepAlive', 'yes'],
    ['Compression', 'no'],
    ['ConnectTimeout', '10'],
    ['IPQoS', 'cs0'],
];

// The per-session Host alias, which is also the vscode-remote authority suffix VS Code shows verbatim as the remote
// window's "[SSH: …]" label — so it reads like the target: <cluster>-<last 6 of the session name> (e.g. delta-493119).
// Never equals a bare cluster name, so it can't shadow the real login host used for SLURM; unique per session in
// practice (the name is a creation timestamp). The same function builds the ssh_config Host line, the authority, and
// the reverse lookup, so all three stay in lockstep.
export const csHostAlias = (cluster: string, sessionName: string): string =>
    `${cluster}-${sessionName.slice(-6)}`;

// Per-session cshost block appended to ~/.cybershuttle/ssh_config (4-space indent matches removeSshConfigEntry).
export function buildSshConfigBlock(
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

// ssh-config models a directive value as a plain string or, for multi-token directives, an array of tokens.
type DirectiveValue = string | { val: string }[];
interface SshConfigDirective {
    type: LineType;
    param: string;
    value: DirectiveValue;
    config: SshConfigDirective[];
}

const directiveText = (value: DirectiveValue): string =>
    Array.isArray(value) ? value.map(t => t.val).join(' ') : value;

export function parseHostsFromConfigText(text: string): SshHost[] {
    const config = parse(text);
    const hosts: SshHost[] = [];
    for (const line of config) {
        if (line.type !== LineType.DIRECTIVE) { continue; }
        // Keep Host sections only: they carry a `config` array, Match sections also carry `criteria`.
        if (!('config' in line) || 'criteria' in line) { continue; }
        const section = line as unknown as SshConfigDirective;
        if (section.param !== 'Host') { continue; }
        const raw = Array.isArray(section.value) ? section.value[0] : section.value;
        const alias = typeof raw === 'string' ? raw.trim().split(/\s+/)[0] : '';
        if (!alias || alias.includes('*') || alias.includes('?')) { continue; }
        const host: SshHost = { name: alias };
        const extraDirectives: string[] = [];
        for (const child of section.config) {
            if (child.type !== LineType.DIRECTIVE) { continue; }
            const value = directiveText(child.value);
            if (child.param === 'HostName') { host.hostname = value; }
            else if (child.param === 'User') { host.user = value; }
            else { extraDirectives.push(`${child.param} ${value}`); }
        }
        if (extraDirectives.length) { host.extraDirectives = extraDirectives; }
        hosts.push(host);
    }
    return hosts;
}

export function addHostToConfigText(text: string, entry: SshConfigEntry): string {
    const config = parse(text);
    config.remove({ Host: entry.Host }); // replace-on-readd: clean recreate, no duplicates
    config.prepend(entry, true); // top of file, after any Include lines
    return config.toString();
}

export function removeHostFromConfigText(text: string, name: string): string {
    const config = parse(text);
    config.remove({ Host: name });
    return config.toString();
}

export function mergeHostsByPriority(...lists: SshHost[][]): SshHost[] {
    const byName = new Map<string, SshHost>();
    for (const host of lists.flat()) {
        if (!byName.has(host.name)) { byName.set(host.name, host); } // keep-first: earlier lists win
    }
    return [...byName.values()];
}

export function addHostToConfigFile(filePath: string, entry: SshConfigEntry): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    updateTextFile(filePath, text => addHostToConfigText(text ?? '', entry), 0o600);
}

export function removeHostFromConfigFile(filePath: string, name: string): void {
    updateTextFile(filePath, text => (text === undefined ? null : removeHostFromConfigText(text, name)), 0o600);
}

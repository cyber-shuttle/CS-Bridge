import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, LineType } from 'ssh-config';
import { SshHost } from '../models';
import { SshConfigEntry } from './sshCommandParser';

// User-managed login hosts. Distinct from the session-managed ~/.cybershuttle/ssh_config (cshost-* aliases).
export const MANAGED_HOSTS_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_hosts');

export function parseHostsFromConfigText(text: string): SshHost[] {
    const config = parse(text);
    const hosts: SshHost[] = [];
    for (const line of config) {
        if (line.type !== LineType.DIRECTIVE) { continue; }
        // Sections carry a `config` child array; Match sections also carry `criteria`. Keep Host sections only.
        if (!('config' in line) || 'criteria' in line) { continue; }
        const section = line as any;
        if (section.param !== 'Host') { continue; }
        const raw = Array.isArray(section.value) ? section.value[0] : section.value;
        const alias = typeof raw === 'string' ? raw.trim().split(/\s+/)[0] : '';
        if (!alias || alias.includes('*') || alias.includes('?')) { continue; }
        if (/^(cshost-|cs-session-|cs-tunnel-)/.test(alias)) { continue; }
        const host: SshHost = { name: alias };
        for (const child of section.config) {
            if (child.type !== LineType.DIRECTIVE) { continue; }
            if (child.param === 'HostName') { host.hostname = child.value; }
            if (child.param === 'User') { host.user = child.value; }
        }
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

export function mergeHostsManagedWins(global: SshHost[], managed: SshHost[]): SshHost[] {
    const managedNames = new Set(managed.map(h => h.name));
    return [...managed, ...global.filter(h => !managedNames.has(h.name))];
}

export function listManagedHosts(): SshHost[] {
    if (!fs.existsSync(MANAGED_HOSTS_PATH)) { return []; }
    const text = fs.readFileSync(MANAGED_HOSTS_PATH, 'utf-8');
    return parseHostsFromConfigText(text).map(h => ({ ...h, managed: true }));
}

export function addHostToConfigFile(filePath: string, entry: SshConfigEntry): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    fs.writeFileSync(filePath, addHostToConfigText(text, entry), { mode: 0o600 });
}

export function removeManagedHost(name: string): void {
    if (!fs.existsSync(MANAGED_HOSTS_PATH)) { return; }
    const text = fs.readFileSync(MANAGED_HOSTS_PATH, 'utf-8');
    fs.writeFileSync(MANAGED_HOSTS_PATH, removeHostFromConfigText(text, name), { mode: 0o600 });
}

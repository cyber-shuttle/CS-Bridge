// SSH hosts for the Resources view: the concrete aliases of ~/.ssh/config and its Include tree, each resolved
// with `ssh -G`. Conversion rewrites the file once into one effective stanza per alias, after a backup and a
// verified round-trip. Every later edit runs under the config lock and is validated with ssh -G before the file
// is replaced, because ssh -G silently rewrites or drops some values.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, LineType } from 'ssh-config';
import { SSHHost } from '../models';
import { CommandRunner } from './commandRunner';
import { lockedUpdateTextFile, tryOr } from './fsSupport';

export const SSH_DIR = path.join(os.homedir(), '.ssh');
export const USER_SSH_CONFIG_PATH = path.join(SSH_DIR, 'config');
export const BACKUP_SSH_CONFIG_PATH = `${USER_SSH_CONFIG_PATH}.csbridge-backup`;
export const CS_SSH_CONFIG_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_config');
export const CS_SSH_KEYS_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_keys');
const CS_INCLUDE_LINE = `Include ${CS_SSH_CONFIG_PATH}`;
const CANONICAL_MARKER = '# Managed by CS Bridge: one effective stanza per alias, edited through the Resources view';

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
// Never equals a bare cluster name, so it can't shadow the real login host used for Slurm; unique per session in
// practice (the name is a creation timestamp). The same function builds the ssh_config Host line, the authority, and
// the reverse lookup, so all three stay in lockstep.
export const csHostAlias = (cluster: string, sessionName: string): string =>
    `${cluster}-${sessionName.slice(-6)}`;

// Per-session block appended to ~/.cybershuttle/ssh_config (4-space indent matches removeSshConfigEntry).
// hostAlias is always csHostAlias() output.
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

// An Include only applies globally when it is uncommented and precedes the first Host/Match block;
// OpenSSH scopes anything after one to that block.
export function includeIsEffective(configText: string, includeLine: string): boolean {
    const wanted = includeLine.trim().replace(/\s+/g, ' ');
    for (const raw of configText.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) { continue; }
        if (/^(Host|Match)\b/i.test(line)) { return false; }
        if (line.replace(/\s+/g, ' ') === wanted) { return true; }
    }
    return false;
}

export const expandTilde = (p: string): string => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const ALIAS_PATTERN = /^[^\s*?!#]+$/;

const tokensOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((t: { val: string }) => t.val) : String(value ?? '').split(/\s+/).filter(Boolean);

// One directory level per wildcard segment, the glob(3) subset OpenSSH's Include uses.
function globPaths(pattern: string): string[] {
    const [first, ...segments] = pattern.split(path.sep);
    let matches = [first || path.sep];
    for (const seg of segments) {
        if (!/[*?]/.test(seg)) { matches = matches.map(m => path.join(m, seg)); continue; }
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        matches = matches.flatMap(dir => tryOr(() => fs.readdirSync(dir), []).sort().filter(e => re.test(e)).map(e => path.join(dir, e)));
    }
    return matches.filter(m => tryOr(() => fs.statSync(m).isFile(), false));
}

export function collectAliases(configPath: string, seen: Set<string> = new Set(), baseDir: string = SSH_DIR): string[] {
    const real = path.resolve(configPath);
    if (seen.has(real) || real === CS_SSH_CONFIG_PATH) { return []; }
    seen.add(real);
    return [...parse(tryOr(() => fs.readFileSync(real, 'utf-8'), ''))].flatMap((line) => {
        if (line.type !== LineType.DIRECTIVE) { return []; }
        if (line.param === 'Include') {
            return tokensOf(line.value).flatMap(p => globPaths(path.resolve(baseDir, expandTilde(p)))).flatMap(f => collectAliases(f, seen, baseDir));
        }
        if (line.param !== 'Host' || !('config' in line) || 'criteria' in line) { return []; }
        return tokensOf(line.value).filter(t => ALIAS_PATTERN.test(t));
    });
}

export function parseSshGOutput(stdout: string): Record<string, string[]> {
    const config: Record<string, string[]> = {};
    for (const line of stdout.split(/\r?\n/)) {
        const [key, ...rest] = line.split(' ');
        if (!key || key === 'host') { continue; }
        (config[key] ??= []).push(rest.join(' '));
    }
    return config;
}

const resolveAlias = (runner: CommandRunner, configPath: string, alias: string) => runner('ssh', ['-G', '-F', configPath, alias]);

export function importHosts(runner: CommandRunner, configPath: string = USER_SSH_CONFIG_PATH, baseDir: string = SSH_DIR): SSHHost[] {
    return [...new Set(collectAliases(configPath, new Set(), baseDir))].flatMap((alias) => {
        const result = resolveAlias(runner, configPath, alias);
        return result.status === 0 ? [{ Name: alias, Config: parseSshGOutput(result.stdout) }] : [];
    });
}

export function renderHostStanza(host: SSHHost): string {
    return [`Host ${host.Name}`, ...Object.keys(host.Config).sort().flatMap(key => host.Config[key].map(value => `    ${key} ${value}`))].join('\n');
}

export function renderCanonicalConfig(hosts: SSHHost[]): string {
    return [CS_INCLUDE_LINE, CANONICAL_MARKER, '', ...hosts.flatMap(host => [renderHostStanza(host), ''])].join('\n');
}

export const isConverted = (configPath: string = USER_SSH_CONFIG_PATH): boolean =>
    tryOr(() => fs.readFileSync(configPath, 'utf-8'), '').split('\n').includes(CANONICAL_MARKER);

function withTempConfig<T>(configPath: string, text: string, fn: (tmpPath: string) => T): T {
    const tmpPath = `${configPath}.csbridge-verify-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, text, { mode: 0o600 });
    try { return fn(tmpPath); }
    finally { fs.rmSync(tmpPath, { force: true }); }
}

export function convertToCanonical(runner: CommandRunner, configPath: string = USER_SSH_CONFIG_PATH, backupPath: string = BACKUP_SSH_CONFIG_PATH): SSHHost[] {
    const hosts = importHosts(runner, configPath);
    const canonical = renderCanonicalConfig(hosts);
    withTempConfig(configPath, canonical, (tmpPath) => {
        const changed = hosts.find(h => resolveAlias(runner, configPath, h.Name).stdout !== resolveAlias(runner, tmpPath, h.Name).stdout);
        if (changed) { throw new Error(`SSH host '${changed.Name}' would resolve differently after conversion; aborting.`); }
    });
    try { fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL); }
    catch (err) { if (!['EEXIST', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) { throw err; } }
    lockedUpdateTextFile(configPath, () => canonical, 0o600);
    return hosts;
}

function assertHostValid(runner: CommandRunner, configPath: string, host: SSHHost, checkRoundTrip: boolean): void {
    const result = resolveAlias(runner, configPath, host.Name);
    if (result.status !== 0) { throw new Error(`SSH host '${host.Name}' failed to validate.`); }
    if (!checkRoundTrip) { return; }
    const resolved = parseSshGOutput(result.stdout);
    const lost = Object.keys(host.Config).find(key => JSON.stringify(resolved[key]) !== JSON.stringify(host.Config[key]));
    if (lost) { throw new Error(`SSH host '${host.Name}' directive '${lost}' did not round-trip.`); }
}

export function validateAndCommit(runner: CommandRunner, edit: (hosts: SSHHost[]) => { hosts: SSHHost[]; edited?: string }, configPath: string = USER_SSH_CONFIG_PATH): void {
    lockedUpdateTextFile(configPath, () => {
        const { hosts, edited } = edit(importHosts(runner, configPath));
        const names = hosts.map(h => h.Name);
        if (names.some(n => !ALIAS_PATTERN.test(n)) || new Set(names).size !== names.length) { throw new Error('Every alias must be one concrete pattern token, and unique.'); }
        const canonical = renderCanonicalConfig(hosts);
        withTempConfig(configPath, canonical, tmpPath => hosts.forEach(host => assertHostValid(runner, tmpPath, host, host.Name === edited)));
        return canonical;
    }, 0o600);
}

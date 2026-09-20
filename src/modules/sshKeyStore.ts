// SSH keys for the Resources view: every IdentityFile the hosts use plus the keys in ~/.ssh, minus CS Bridge's
// own session keys. Only metadata reaches the webview, never key bytes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SSHHost, SshKeyInfo } from '../models';
import { CommandRunner } from './commandRunner';
import { tryOr } from './fsSupport';
import { CS_SSH_KEYS_DIR, SSH_DIR, expandTilde } from './sshHostsStore';

const isGenerated = (absPath: string): boolean =>
    absPath.startsWith(`${CS_SSH_KEYS_DIR}${path.sep}`) || /^id_cshost-/.test(path.basename(absPath));

const fingerprint = (filePath: string, runner: CommandRunner): string | undefined => {
    const result = runner('ssh-keygen', ['-l', '-f', filePath]);
    return result.status === 0 ? result.stdout.match(/SHA256:\S+/)?.[0] : undefined;
};

const privateOf = (file: string): string => (file.endsWith('.pub') ? file.slice(0, -4) : file);

// Direct children ssh-keygen recognizes, each named by its private path; a .pub counts only without its private half.
function candidateKeyPaths(runner: CommandRunner, sshDir: string): string[] {
    return tryOr(() => fs.readdirSync(sshDir), [])
        .map(name => path.join(sshDir, name))
        .filter(file => tryOr(() => fs.statSync(file).isFile(), false) && !isGenerated(file))
        .filter(file => (privateOf(file) === file || !fs.existsSync(privateOf(file))) && fingerprint(file, runner) !== undefined)
        .map(privateOf);
}

export function discoverKeys(hosts: SSHHost[], runner: CommandRunner, sshDir: string = SSH_DIR): SshKeyInfo[] {
    const refs = hosts
        .flatMap(host => (host.Config.identityfile ?? []).map(raw => [path.resolve(os.homedir(), expandTilde(raw)), host.Name] as const))
        .filter(([keyPath]) => !isGenerated(keyPath));
    const keyPaths = new Set([...refs.map(([keyPath]) => keyPath), ...candidateKeyPaths(runner, sshDir)]);
    return [...keyPaths].flatMap((keyPath): SshKeyInfo[] => {
        const probe = [keyPath, `${keyPath}.pub`].find(p => fs.existsSync(p));
        const fp = probe && fingerprint(probe, runner);
        if (probe && !fp) { return []; }
        const status = !probe ? 'missing' : probe === keyPath ? 'private' : 'public-only';
        return [{ path: keyPath, fingerprint: fp || '', status, hosts: [...new Set(refs.filter(([k]) => k === keyPath).map(([, h]) => h))] }];
    }).sort((a, b) => a.path.localeCompare(b.path));
}

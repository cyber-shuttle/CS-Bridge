import { SshHost } from '../models';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { Logger, errMsg } from '../logger';
import { USER_SSH_CONFIG_PATH, SYSTEM_SSH_CONFIG_PATH, mergeHostsByPriority, parseHostsFromConfigText, buildSshConfigBlock } from './sshHostsStore';

const logger = Logger.getInstance();
const CS_SSH_CONFIG_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_config');
const CS_SSH_KEYS_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_keys');
const CS_SSH_CONTROL_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_control');
const LEGACY_MANAGED_HOSTS_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_hosts');

const sessionKeyPath = (sessionId: string): string => path.join(CS_SSH_KEYS_DIR, `id_cshost-${sessionId}`);

export class SshManager {
    private static instance: SshManager | undefined;

    private constructor(private readonly extensionUri: vscode.Uri) {
        if (!fs.existsSync(CS_SSH_CONTROL_DIR)) {
            fs.mkdirSync(CS_SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
        }

        if (!fs.existsSync(CS_SSH_KEYS_DIR)) {
            fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
        }
    }

    public static initInstance(extensionUri: vscode.Uri): SshManager {
        if (!SshManager.instance) {
            SshManager.instance = new SshManager(extensionUri);
        }

        // Include'd above the user's global entries so cshost-* aliases win via SSH first-match.
        if (!fs.existsSync(CS_SSH_CONFIG_PATH)) {
            fs.mkdirSync(path.dirname(CS_SSH_CONFIG_PATH), { recursive: true, mode: 0o700 });
            fs.writeFileSync(CS_SSH_CONFIG_PATH, '', { mode: 0o600 });
        }
        SshManager.instance.ensureSshInclude(CS_SSH_CONFIG_PATH);
        SshManager.instance.removeSshInclude(LEGACY_MANAGED_HOSTS_PATH);
        return SshManager.instance;
    }

    public static getInstance(): SshManager {
        if (!SshManager.instance) {
            throw new Error('SshManager not initialized. Call initInstance() first.');
        }
        return SshManager.instance;
    }

    private readHostsFile(filePath: string, source: 'user' | 'system'): SshHost[] {
        try {
            if (!fs.existsSync(filePath)) { return []; }
            const text = fs.readFileSync(filePath, 'utf-8');
            return parseHostsFromConfigText(text).map(h => ({ ...h, source }));
        }
        catch (err) {
            logger.error(`Error reading SSH config ${filePath}:`, err);
            return [];
        }
    }

    public getMergedHosts(): SshHost[] {
        return mergeHostsByPriority(
            this.readHostsFile(USER_SSH_CONFIG_PATH, 'user'),
            this.readHostsFile(SYSTEM_SSH_CONFIG_PATH, 'system'),
        );
    }

    private buildControlMasterArgs(hostName: string): string[] {
        // Windows OpenSSH has no Unix-socket ControlMaster ("getsockname failed: Not a socket").
        if (process.platform === 'win32') {
            return [];
        }
        // Hashed socket name keeps ControlPath under the 104-byte UNIX socket limit.
        const hash = crypto.createHash('sha256').update(hostName).digest('hex').substring(0, 16);
        const socketPath = path.join(CS_SSH_CONTROL_DIR, hash);
        return [
            '-o', `ControlMaster=auto`,
            '-o', `ControlPath=${socketPath}`,
            '-o', `ControlPersist=600`,
        ];
    }

    public runRemoteCommand(hostName: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
        return new Promise((resolve, reject) => {
            const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
            const cancelFile = path.join(askpassDir, 'cancel');

            // JS does the askpass IPC; a platform wrapper invokes it via VS Code's electron-as-node.
            const askpassScript = path.join(this.extensionUri.fsPath, 'scripts', 'askpass.js');
            const isWin = process.platform === 'win32';
            const askpassWrapper = path.join(this.extensionUri.fsPath, 'scripts', isWin ? 'askpass.cmd' : 'askpass.sh');
            if (!isWin) {
                try { fs.chmodSync(askpassWrapper, 0o755); }
                catch { /* best-effort - vsix should already have +x */ }
            }

            // Detach stdin so SSH is forced to use SSH_ASKPASS
            const sshProcess = spawn('ssh', [
                ...this.buildControlMasterArgs(hostName),
                '-o', 'NumberOfPasswordPrompts=3',
                hostName,
                command,
            ], {
                env: {
                    ...process.env,
                    SSH_ASKPASS: askpassWrapper,
                    SSH_ASKPASS_REQUIRE: 'force',
                    CS_ASKPASS_DIR: askpassDir,
                    CS_ASKPASS_JS: askpassScript,
                    CS_NODE_BIN: process.execPath,
                    DISPLAY: ':0',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdoutData = '';
            let stderrData = '';
            let disposed = false;
            const handledPrompts = new Set<string>();

            sshProcess.stdout.on('data', (data: Buffer) => {
                stdoutData += data.toString();
            });

            sshProcess.stderr.on('data', (data: Buffer) => {
                stderrData += data.toString();
            });

            const pollInterval = setInterval(async () => {
                if (disposed) {
                    return;
                }

                try {
                    const files = fs.readdirSync(askpassDir);
                    for (const file of files) {
                        if (!file.startsWith('prompt-') || handledPrompts.has(file)) {
                            continue;
                        }

                        handledPrompts.add(file);

                        const promptFilePath = path.join(askpassDir, file);
                        const content = fs.readFileSync(promptFilePath, 'utf-8');
                        const { id, prompt } = JSON.parse(content);
                        const responseFile = path.join(askpassDir, `response-${id}`);

                        const password = await vscode.window.showInputBox({
                            title: `SSH Authentication — ${hostName}`,
                            prompt: prompt.trim(),
                            password: true,
                            ignoreFocusOut: true,
                        });

                        if (password !== undefined) {
                            fs.writeFileSync(responseFile, password, 'utf-8');
                        }
                        else {
                            fs.writeFileSync(cancelFile, '', 'utf-8');
                            sshProcess.kill();
                        }
                    }
                }
                catch {
                    // Ignore file access errors during polling
                }
            }, 200);

            const cleanup = () => {
                disposed = true;
                clearInterval(pollInterval);
                try { fs.rmSync(askpassDir, { recursive: true, force: true }); }
                catch { /* best-effort temp cleanup */ }
            };

            sshProcess.on('close', (code: number | null) => {
                cleanup();
                resolve({ stdout: stdoutData, stderr: stderrData, code: code ?? 1 });
            });

            sshProcess.on('error', (err: Error) => {
                cleanup();
                reject(err);
            });
        });
    }

    private ensureSshInclude(targetPath: string): void {
        const sshDir = path.join(os.homedir(), '.ssh');
        const sshConfigPath = path.join(sshDir, 'config');
        const includeLine = `Include ${targetPath}`;

        try {
            if (!fs.existsSync(sshDir)) {
                fs.mkdirSync(sshDir, { mode: 0o700 });
            }
            if (!fs.existsSync(sshConfigPath)) {
                fs.writeFileSync(sshConfigPath, `${includeLine}\n`, { mode: 0o600 });
                return;
            }
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            if (!content.includes(includeLine)) {
                // Include must appear before any Host/Match blocks to take effect
                fs.writeFileSync(sshConfigPath, `${includeLine}\n${content}`);
            }
        }
        catch (err) {
            logger.error(`[ssh] Failed to add Include to ~/.ssh/config: ${errMsg(err)}`);
        }
    }

    private removeSshInclude(targetPath: string): void {
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        const includeLine = `Include ${targetPath}`;
        try {
            if (!fs.existsSync(sshConfigPath)) { return; }
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            if (!content.includes(includeLine)) { return; }
            fs.writeFileSync(sshConfigPath, content.split('\n').filter(line => line.trim() !== includeLine).join('\n'));
        }
        catch (err) {
            logger.error(`[ssh] Failed to remove Include from ~/.ssh/config: ${errMsg(err)}`);
        }
    }
}

export function addSshConfigEntry(sessionId: string, localPort: number, privateKey: string): string {
    const hostAlias = `cshost-${sessionId}`;
    removeSshConfigEntry(sessionId, hostAlias);
    writeSessionPrivateKey(sessionId, privateKey);

    const hostname = '127.0.0.1';
    const user = 'cs-ssh-user'; // any non-empty value works; the custom SSH server ignores the username
    const configBlock = buildSshConfigBlock(sessionId, hostAlias, hostname, localPort, user, sessionKeyPath(sessionId));

    try {
        fs.appendFileSync(CS_SSH_CONFIG_PATH, `\n${configBlock}\n`);
    }
    catch (err) {
        logger.error(`Failed to write SSH config for session ${sessionId}:`, err);
    }
    return hostAlias;
}

export function writeSessionPrivateKey(sessionId: string, privateKey: string): void {
    fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sessionKeyPath(sessionId), privateKey, { mode: 0o600 });
}

export function getSessionPrivateKey(sessionId: string): string | undefined {
    try { return fs.readFileSync(sessionKeyPath(sessionId), 'utf-8'); }
    catch { return undefined; }
}

export function removeSessionPrivateKey(sessionId: string): void {
    const privateKeyPath = sessionKeyPath(sessionId);
    try {
        if (fs.existsSync(privateKeyPath)) {
            fs.unlinkSync(privateKeyPath);
        }
    }
    catch (err) {
        logger.error(`Failed to remove SSH private key for session ${sessionId}:`, err);
    }
}

export function removeSshConfigEntry(sessionId: string, hostAlias: string): void {
    try {
        const content = fs.readFileSync(CS_SSH_CONFIG_PATH, 'utf-8');
        const re = new RegExp(
            `(?:\\n|^)# CS-Bridge auto-generated for session ${sessionId}\\nHost ${hostAlias}\\n(?:    [^\\n]+\\n)*`,
            'gm',
        );
        const cleaned = content.replace(re, '');
        if (cleaned !== content) {
            fs.writeFileSync(CS_SSH_CONFIG_PATH, cleaned);
        }

        removeSessionPrivateKey(sessionId);
    }
    catch (err) {
        logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
    }
}

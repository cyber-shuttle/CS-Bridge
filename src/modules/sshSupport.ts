import { SshHost } from "../models";
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn } from "child_process";
import * as crypto from 'crypto';
import { Logger } from "../logger";
import { USER_SSH_CONFIG_PATH, SYSTEM_SSH_CONFIG_PATH, mergeHostsByPriority, parseHostsFromConfigText, buildSshConfigBlock } from './sshHostsStore';

const logger = Logger.getInstance();
const CS_SSH_CONFIG_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_config');
const CS_SSH_KEYS_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_keys');
const CS_SSH_CONTROL_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_control');
// Deprecated managed-hosts level (SWP-49); only its stale Include is stripped from ~/.ssh/config on init.
const LEGACY_MANAGED_HOSTS_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_hosts');

export class SshManager {

    private static _instance: SshManager | undefined;

    private constructor(private readonly _extensionUri: vscode.Uri) {
        if (!fs.existsSync(CS_SSH_CONTROL_DIR)) {
            fs.mkdirSync(CS_SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
        }

        if (!fs.existsSync(CS_SSH_KEYS_DIR)) {
            fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
        }
    }

    public static initInstance(extensionUri: vscode.Uri): SshManager {
        if (!SshManager._instance) {
            SshManager._instance = new SshManager(extensionUri);
        }

        // cshost-* session aliases live here, Include'd above the user's global entries so they win via SSH first-match.
        if (!fs.existsSync(CS_SSH_CONFIG_PATH)) {
            fs.mkdirSync(path.dirname(CS_SSH_CONFIG_PATH), { recursive: true, mode: 0o700 });
            fs.writeFileSync(CS_SSH_CONFIG_PATH, '', { mode: 0o600 });
        }
        SshManager._instance._ensureSshInclude(CS_SSH_CONFIG_PATH);
        SshManager._instance._removeSshInclude(LEGACY_MANAGED_HOSTS_PATH);
        return SshManager._instance;
    }

    public static getInstance(): SshManager {
        if (!SshManager._instance) {
            throw new Error('SshManager not initialized. Call initInstance() first.');
        }
        return SshManager._instance;
    }

    // Top-level Host entries tagged with their source; [] if missing/unreadable. No Include follow-through.
    private _readHostsFile(filePath: string, source: 'user' | 'system'): SshHost[] {
        try {
            if (!fs.existsSync(filePath)) { return []; }
            const text = fs.readFileSync(filePath, 'utf-8');
            return parseHostsFromConfigText(text).map(h => ({ ...h, source }));
        } catch (err) {
            logger.error(`Error reading SSH config ${filePath}:`, err);
            return [];
        }
    }

    // User then system, deduped first-wins so a user host overrides a same-named system host.
    public getMergedHosts(): SshHost[] {
        return mergeHostsByPriority(
            this._readHostsFile(USER_SSH_CONFIG_PATH, 'user'),
            this._readHostsFile(SYSTEM_SSH_CONFIG_PATH, 'system'),
        );
    }

    /**
    * Get SSH args for connection multiplexing (ControlMaster).
    * Uses a short hashed socket name to stay under the 104-byte limit.
    */
    private getControlMasterArgs(hostName: string): string[] {
        // Windows OpenSSH doesn't support Unix-socket-based ControlMaster
        // ("getsockname failed: Not a socket"). Skip multiplexing on Windows.
        if (process.platform === 'win32') {
            return [];
        }
        const hash = crypto.createHash('sha256').update(hostName).digest('hex').substring(0, 16);
        const socketPath = path.join(CS_SSH_CONTROL_DIR, hash);
        return [
            '-o', `ControlMaster=auto`,
            '-o', `ControlPath=${socketPath}`,
            '-o', `ControlPersist=600`,
        ];
    }

    /**
    * Run a command on a remote SSH host.
    * Handles SSH_ASKPASS IPC for password/passphrase prompts and ControlMaster multiplexing.
    * Returns a promise that resolves with { stdout, stderr, code }.
    */
    public runRemoteCommand(hostName: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
        return new Promise((resolve, reject) => {
            // Create a temp directory for askpass IPC
            const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
            const cancelFile = path.join(sessionDir, 'cancel');

            // Bundled askpass helper - JS does the IPC; the platform-specific wrapper invokes it via VS Code's electron-as-node.
            const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');
            const isWin = process.platform === 'win32';
            const askpassWrapper = path.join(this._extensionUri.fsPath, 'scripts', isWin ? 'askpass.cmd' : 'askpass.sh');
            if (!isWin) { try { fs.chmodSync(askpassWrapper, 0o755); } catch { /* best-effort - vsix should already have +x */ } }

            // Detach stdin so SSH is forced to use SSH_ASKPASS
            const sshProcess = spawn('ssh', [
                ...this.getControlMasterArgs(hostName),
                '-o', 'NumberOfPasswordPrompts=3',
                hostName,
                command,
            ], {
                env: {
                    ...process.env,
                    SSH_ASKPASS: askpassWrapper,
                    SSH_ASKPASS_REQUIRE: 'force',
                    CS_ASKPASS_DIR: sessionDir,
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

            // Poll for prompt-* files from the askpass script
            const pollInterval = setInterval(async () => {
                if (disposed) {
                    return;
                }

                try {
                    const files = fs.readdirSync(sessionDir);
                    for (const file of files) {
                        if (!file.startsWith('prompt-') || handledPrompts.has(file)) {
                            continue;
                        }

                        handledPrompts.add(file);

                        const promptFilePath = path.join(sessionDir, file);
                        const content = fs.readFileSync(promptFilePath, 'utf-8');
                        const { id, prompt } = JSON.parse(content);
                        const responseFile = path.join(sessionDir, `response-${id}`);

                        const password = await vscode.window.showInputBox({
                            title: `SSH Authentication — ${hostName}`,
                            prompt: prompt.trim(),
                            password: true,
                            ignoreFocusOut: true,
                        });

                        if (password !== undefined) {
                            fs.writeFileSync(responseFile, password, 'utf-8');
                        } else {
                            fs.writeFileSync(cancelFile, '', 'utf-8');
                            sshProcess.kill();
                        }
                    }
                } catch {
                    // Ignore file access errors during polling
                }
            }, 200);

            const cleanup = () => {
                disposed = true;
                clearInterval(pollInterval);
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { }
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

    private _ensureSshInclude(targetPath: string): void {
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
        } catch (err: any) {
            logger.error(`[ssh] Failed to add Include to ~/.ssh/config: ${err.message}`);
        }
    }

    // Strip a previously-added `Include <targetPath>` line from ~/.ssh/config (retires a deprecated include).
    private _removeSshInclude(targetPath: string): void {
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        const includeLine = `Include ${targetPath}`;
        try {
            if (!fs.existsSync(sshConfigPath)) { return; }
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            if (!content.includes(includeLine)) { return; }
            fs.writeFileSync(sshConfigPath, content.split('\n').filter(line => line.trim() !== includeLine).join('\n'));
        } catch (err: any) {
            logger.error(`[ssh] Failed to remove Include from ~/.ssh/config: ${err.message}`);
        }
    }

}

// Returns the host alias to use for SSH connections (e.g. "cshost-SESSIONID")
export function addSshConfigEntry(sessionId: string, localPort: number, privateKey: string): string {

    const hostAlias = `cshost-${sessionId}`;

    removeSshConfigEntry(sessionId, hostAlias);
    writeSessionPrivateKey(sessionId, privateKey);
    const privateKeyPath = path.join(CS_SSH_KEYS_DIR, `id_${hostAlias}`);


    const hostname = '127.0.0.1';
    const user = 'cs-ssh-user'; // No need to have this as the actual username on the cluster, since we'll be using a custom SSH server that ignores it. But it needs to be set to something non-empty to avoid SSH client errors.
    const configBlock = buildSshConfigBlock(sessionId, hostAlias, hostname, localPort, user, privateKeyPath);

    try {
        fs.appendFileSync(CS_SSH_CONFIG_PATH, `\n${configBlock}\n`);
    } catch (err) {
        logger.error(`Failed to write SSH config for session ${sessionId}:`, err);
    }
    return hostAlias;
}

// Persist the per-session SSH key (0600). Written at Step 1 so a reload at ready_to_connect can
// reconnect with no login-node call; read back via getSessionPrivateKey.
export function writeSessionPrivateKey(sessionId: string, privateKey: string): void {
    fs.mkdirSync(CS_SSH_KEYS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(CS_SSH_KEYS_DIR, `id_cshost-${sessionId}`), privateKey, { mode: 0o600 });
}

// Read the per-session key from disk (used on reattach, where it's no longer in memory).
export function getSessionPrivateKey(sessionId: string): string | undefined {
    const privateKeyPath = path.join(CS_SSH_KEYS_DIR, `id_cshost-${sessionId}`);
    try { return fs.readFileSync(privateKeyPath, 'utf-8'); } catch { return undefined; }
}

export function removeSessionPrivateKey(sessionId: string): void {
    const hostAlias = `cshost-${sessionId}`;
    const privateKeyPath = path.join(CS_SSH_KEYS_DIR, `id_${hostAlias}`);
    try {
        if (fs.existsSync(privateKeyPath)) {
            fs.unlinkSync(privateKeyPath);
        }
    } catch (err) {
        logger.error(`Failed to remove SSH private key for session ${sessionId}:`, err);
    }
}

export function removeSshConfigEntry(sessionId: string, hostAlias: string): void {

    try {
        const content = fs.readFileSync(CS_SSH_CONFIG_PATH, 'utf-8');
        const re = new RegExp(
            `(?:\\n|^)# CS-Bridge auto-generated for session ${sessionId}\\nHost ${hostAlias}\\n(?:    [^\\n]+\\n)*`,
            'gm'
        );
        const cleaned = content.replace(re, '');
        if (cleaned !== content) {
            fs.writeFileSync(CS_SSH_CONFIG_PATH, cleaned);
        }

        removeSessionPrivateKey(sessionId);
    } catch (err) {
        logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
    }
}

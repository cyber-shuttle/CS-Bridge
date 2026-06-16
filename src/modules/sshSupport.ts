import { GresInfo, SlurmClusterInfo, SlurmPartitionInfo, SlurmSession, SshHost, TunnelCredential } from "../models";
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn } from "child_process";
import * as crypto from 'crypto';
import { Logger } from "../logger";
import { USER_SSH_CONFIG_PATH, SYSTEM_SSH_CONFIG_PATH, mergeHostsByPriority, parseHostsFromConfigText, buildSessionSshConfigBlock } from './sshHostsStore';

const logger = Logger.getInstance();
const CS_SSH_CONFIG_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_config');
const CS_SSH_KEYS_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_keys');
const CS_SSH_CONTROL_DIR = path.join(os.homedir(), '.cybershuttle', 'ssh_control');
// Deprecated managed-hosts level (SWP-49); only its stale Include is stripped from ~/.ssh/config on init.
const LEGACY_MANAGED_HOSTS_PATH = path.join(os.homedir(), '.cybershuttle', 'ssh_hosts');

/** Detect OAuth2 device flow prompts from pam_oauth2_device. */
function parseDeviceFlowPrompt(prompt: string): string | null {
    const urlMatch = prompt.match(/Authenticate at[ \t]*\n-+\n[ \t]*(https:\/\/[^\s\n]+)/);
    if (!urlMatch) {
        return null;
    }
    return urlMatch[1];
}

/** Show device flow auth UI, presents a modal dialog and opens up the browser on user action. Returns '' on success, undefined on cancel. */
async function showDeviceFlowAuth(hostName: string, url: string): Promise<string | undefined> {
    while (true) {
        const detail = `Sign in using your browser to authenticate this SSH session.\n\nURL: ${url}\n\nClick "Open Browser" to proceed, then "Done" when finished.`;

        const result = await vscode.window.showInformationMessage(
            `SSH Authentication — ${hostName}`,
            { modal: true, detail },
            'Open Browser',
            'Done',
        );

        if (result === 'Open Browser') {
            await vscode.env.openExternal(vscode.Uri.parse(url));
            continue;
        }

        if (result === 'Done') {
            return '';
        }

        return undefined;
    }
}

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
            let handlingPrompt = false;
            const handledPrompts = new Set<string>();

            sshProcess.stdout.on('data', (data: Buffer) => {
                stdoutData += data.toString();
            });

            sshProcess.stderr.on('data', (data: Buffer) => {
                stderrData += data.toString();
            });

            // Poll for prompt-* files from the askpass script
            const pollInterval = setInterval(async () => {
                if (disposed || handlingPrompt) {
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
                        let parsed;
                        try {
                            parsed = JSON.parse(content);
                        } catch {
                            // askpass may still be writing this file, skip and retry
                            handledPrompts.delete(file);
                            continue;
                        }
                        const { id, prompt } = parsed;
                        const responseFile = path.join(sessionDir, `response-${id}`);

                        handlingPrompt = true;
                        try {
                            const deviceFlowUrl = parseDeviceFlowPrompt(prompt);
                            let response: string | undefined;

                            if (deviceFlowUrl) {
                                response = await showDeviceFlowAuth(hostName, deviceFlowUrl);
                            } else {
                                response = await vscode.window.showInputBox({
                                    title: `SSH Authentication — ${hostName}`,
                                    prompt: prompt.trim(),
                                    password: true,
                                    ignoreFocusOut: true,
                                });
                            }

                            if (response !== undefined) {
                                fs.writeFileSync(responseFile, response, { encoding: 'utf-8', mode: 0o600 });
                            } else {
                                fs.writeFileSync(cancelFile, '', 'utf-8');
                                sshProcess.kill();
                            }
                        } finally {
                            handlingPrompt = false;
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

/**
* Query SLURM partition and account info for the current user on a remote host.
* Returns a SlurmClusterInfo with accounts, partitions, and homeDir fields.
*/
export async function getSlurmClusterInfo(hostName: string): Promise<SlurmClusterInfo> {
    const sshManager = SshManager.getInstance();
    const log = Logger.getInstance();
    const clusterInfo: SlurmClusterInfo = { host: hostName, accounts: [], partitions: [] };
    try {
        const accountResult = await sshManager.runRemoteCommand(hostName,
            'sacctmgr show associations where user=$USER format=Account -p');

        if (accountResult.code === 0) {
            log.info(accountResult.stdout);

            // Parse pipe-delimited output into account → QOS mapping
            const lines = accountResult.stdout.trim().split('\n');

            for (let i = 1; i < lines.length; i++) { // skip header
                const parts = lines[i].trim().split('|');
                log.info(`Parsed account line: ${lines[i]} → ${parts} {length: ${parts.length}}`);
                if (parts.length >= 1) {
                    const account = parts[0].trim();
                    if (account) {
                        clusterInfo.accounts.push(account);
                    }
                }
            }
        } else {
            log.warn(`Command exited with code ${accountResult.code}`);
            if (accountResult.stderr) {
                log.error(accountResult.stderr);
            }
            throw new Error(`Failed to query associations: ${accountResult.stderr || 'Unknown error'}`);
        }

    } catch (err) {
        log.error('Error querying associations:', err);
        throw err;
    }

    try {
        const partitionResult = await sshManager.runRemoteCommand(hostName, 'sinfo -h -o "%P|%c|%m|%G"');
        /* Example output:
        interactive-cpu|24|191000+|gpu:v100:2(S:0-1)
        interactive-cpu1|24|385000+|gpu:rtx_6000:4(S:0-1)
        interactive-cpu2|64|515000|gpu:a100:2(S:2,5)
        cpu-small*|24+|191000+|(null)
        cpu-amd|128|515000+|(null)
        */
        if (partitionResult.code === 0) {
            log.info(partitionResult.stdout);
            clusterInfo.partitions = partitionResult.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map(parsePartitionLine);
        }
    } catch (err) {
        log.warn(`Failed to query partitions: ${err instanceof Error ? err.message : String(err)}`);
        // Don't throw, since accounts info may still be useful
    }

    try {
        const homeResult = await sshManager.runRemoteCommand(hostName, 'echo $HOME');
        if (homeResult.code === 0) { clusterInfo.homeDir = homeResult.stdout.trim(); }
    } catch (err) {
        log.warn(`Failed to query $HOME: ${err instanceof Error ? err.message : String(err)}`);
    }

    return clusterInfo;
}

export function generateSlurmScript(session: SlurmSession, tunnelCred: TunnelCredential): string {

    // Parse memory value (e.g. "8 GB" → "8G")
    const memSlurm = session.memory.replace(/\s+/g, '');

    // Build #SBATCH lines.
    const sbatchLines = [
        `#SBATCH --job-name=linkspan-session`,
        `#SBATCH --ntasks=1`,
        `#SBATCH --cpus-per-task=${session.cpus}`,
        `#SBATCH --mem=${memSlurm}`,
        `#SBATCH --time=${session.wallTime}`,
        `#SBATCH --partition=${session.queue}`,
        `#SBATCH --account=${session.allocation}`,
    ];

    // Add GPU if selected (format: "type:count" or "count")
    if (session.gpuClass !== '' && session.gpuCount > 0) {
        sbatchLines.push(`#SBATCH --gres=gpu:${session.gpuClass}`);
    }

    // Build the workflow YAML that will be passed to linkspan via stdin.

    const scriptLines = [
        `#!/bin/bash`,
        ...sbatchLines,
        ``,
        `# --- Set up log files using $HOME ---`,
        `LOG_DIR="$HOME/.cybershuttle/logs"`,
        `mkdir -p "$LOG_DIR"`,
        `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
        ``,
    ];

    scriptLines.push(
        `# --- Run linkspan (pre-deployed via scp) ---`,
        `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
        `"$LINKSPAN_BIN" --port 0 --tunnel-auth-token '${tunnelCred.authToken}' --tunnel-id '${session.tunnelId ?? ''}' --tunnel-cluster '${session.tunnelCluster ?? ''}' -tunnel-enable`,
    );

    const script = scriptLines.join('\n');

    return script;
}


/// Parsing helpers

function parsePartitionLine(line: string): SlurmPartitionInfo {
    const parts = line.split("|").map((p) => p.trim());

    if (parts.length !== 4) {
        throw new Error(`Invalid sinfo line: ${line}`);
    }

    const [rawName, rawCpuCount, rawMemory, rawGres] = parts;

    return {
        name: rawName.replace(/\*$/, ""), // remove default-partition marker
        cpuCount: parseLeadingInt(rawCpuCount), // handles "24+"
        memory: rawMemory, // keep "191000+" as-is
        gres: parseGres(rawGres),
    };
}

function parseLeadingInt(value: string): number {
    const match = value.match(/\d+/);
    if (!match) {
        throw new Error(`Could not parse integer from: ${value}`);
    }
    return Number.parseInt(match[0], 10);
}

function parseGres(rawGres: string): GresInfo[] {
    if (!rawGres || rawGres === "(null)") {
        return [];
    }

    return splitTopLevelComma(rawGres).map((entry) => {
        // Examples:
        // gpu:v100:2(S:0-1)
        // gpu:rtx_6000:4(S:0-1)
        // gpu:8
        const match = entry.match(/^(.+):(\d+)(?:\([^)]*\))?$/);

        if (!match) {
            throw new Error(`Invalid GRES entry: ${entry}`);
        }

        return {
            name: match[1],   // e.g. "gpu:v100"
            count: Number.parseInt(match[2], 10),
        };
    });
}

function splitTopLevelComma(value: string): string[] {
    const result: string[] = [];
    let current = "";
    let depth = 0;

    for (const ch of value) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;

        if (ch === "," && depth === 0) {
            result.push(current.trim());
            current = "";
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

// Returns the host alias to use for SSH connections (e.g. "cshost-SESSIONID")
export function createSSHConfigEntry(sessionId: string, localPort: number, privateKey: string): string {

    const hostAlias = `cshost-${sessionId}`;

    clearSSHConfigEntry(sessionId, hostAlias);
    writeSessionPrivateKey(sessionId, privateKey);
    const privateKeyPath = path.join(CS_SSH_KEYS_DIR, `id_${hostAlias}`);


    const hostname = '127.0.0.1';
    const user = 'cs-ssh-user'; // No need to have this as the actual username on the cluster, since we'll be using a custom SSH server that ignores it. But it needs to be set to something non-empty to avoid SSH client errors.
    const configBlock = buildSessionSshConfigBlock(sessionId, hostAlias, hostname, localPort, user, privateKeyPath);

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

export function removeSSHprivateKeyForSession(sessionId: string): void {
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

export function clearSSHConfigEntry(sessionId: string, hostAlias: string): void {

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

        removeSSHprivateKeyForSession(sessionId);
    } catch (err) {
        logger.error(`Failed to clear SSH config entry for session ${sessionId}:`, err);
    }
}

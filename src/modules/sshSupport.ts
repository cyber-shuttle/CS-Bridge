import { GresInfo, SlurmClusterInfo, SlurmPartitionInfo, SshHost } from "../models";
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { spawn } from "child_process";
import * as crypto from 'crypto';
import { Logger } from "../logger";


export class SshManager {

    private static _instance: SshManager | undefined;
    private _sshControlDir: string;

    private constructor(private readonly _extensionUri: vscode.Uri) {
        this._sshControlDir = path.join(os.homedir(), '.cs-ssh');
        if (!fs.existsSync(this._sshControlDir)) {
            fs.mkdirSync(this._sshControlDir, { mode: 0o700 });
        }
    }

    public static initInstance(extensionUri: vscode.Uri): SshManager {
        if (!SshManager._instance) {
            SshManager._instance = new SshManager(extensionUri);
        }
        return SshManager._instance;
    }

    public static getInstance(): SshManager {
        if (!SshManager._instance) {
            throw new Error('SshManager not initialized. Call initInstance() first.');
        }
        return SshManager._instance;
    }

    /**
    * Parse SSH config file and extract host entries
    */
    public getSshHostsFromConfig(): SshHost[] {
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

    /**
    * Get SSH args for connection multiplexing (ControlMaster).
    * Uses a short hashed socket name to stay under the 104-byte limit.
    */
    private getControlMasterArgs(hostName: string): string[] {
        const hash = crypto.createHash('sha256').update(hostName).digest('hex').substring(0, 16);
        const socketPath = path.join(this._sshControlDir, hash);
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

            // Path to our askpass helper script
            const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');

            // Detach stdin so SSH is forced to use SSH_ASKPASS
            const sshProcess = spawn('ssh', [
                ...this.getControlMasterArgs(hostName),
                '-o', 'NumberOfPasswordPrompts=3',
                hostName,
                command,
            ], {
                env: {
                    ...process.env,
                    SSH_ASKPASS: askpassScript,
                    SSH_ASKPASS_REQUIRE: 'force',
                    CS_ASKPASS_DIR: sessionDir,
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

}

/**
* Query SLURM partition and account info for the current user on a remote host
* using scripts/info.sh. Sends a partition→info mapping to the webview
* to populate the Partition and Allocation dropdowns.
* Serves cached data immediately if available, then refreshes in background.
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
            // Send to webview
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

    return clusterInfo;
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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

interface SshHost {
    name: string;
    hostname?: string;
    user?: string;
}

interface JobSession {
    id: string;
    host: string;
    cpus: string;
    memory: string;
    gpu: string;
    wallTime: string;
    queue: string;
    allocation: string;
    status: 'Pending' | 'Active';
    submittedAt: Date;
}

export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cybershuttle.sidebarView';

    private _view?: vscode.WebviewView;
    private _outputChannel: vscode.OutputChannel;
    private _sshControlDir: string;
    private _jobSessions: JobSession[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {
        this._outputChannel = vscode.window.createOutputChannel('CyberShuttle');
        // Short path to stay under macOS 104-byte Unix socket limit
        this._sshControlDir = path.join(os.homedir(), '.cs-ssh');
        if (!fs.existsSync(this._sshControlDir)) {
            fs.mkdirSync(this._sshControlDir, { mode: 0o700 });
        }
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
     * Parse SSH config file and extract host entries
     */
    private getSshHosts(): SshHost[] {
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
                    if (!hostName.includes('*') && !hostName.includes('?')) {
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

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((data) => {
            switch (data.type) {
                case 'auth': {
                    vscode.commands.executeCommand('cybershuttle.auth');
                    break;
                }
                case 'openWorkspace': {
                    vscode.commands.executeCommand('cybershuttle.openWorkspace');
                    break;
                }
                case 'connectSsh': {
                    this.connectToSshHost(data.host);
                    break;
                }
                case 'listFiles': {
                    this.listRemoteFiles(data.host);
                    break;
                }
                case 'refresh': {
                    this.refresh();
                    break;
                }
                case 'addSshHost': {
                    this.addSshHost();
                    break;
                }
                case 'createJob': {
                    this.createJob(data.host, data.cpus, data.memory, data.gpu, data.wallTime, data.queue, data.allocation);
                    break;
                }
                case 'queryAssociations': {
                    this.queryAssociations(data.host);
                    break;
                }
                case 'removeSession': {
                    this._jobSessions = this._jobSessions.filter(s => s.id !== data.sessionId);
                    this.refresh();
                    break;
                }
            }
        });
    }

    /**
     * Add a new SSH host using VS Code Remote-SSH extension
     */
    private async addSshHost() {
        // Try different commands that Remote-SSH extension provides
        try {
            // This command opens the "Add New SSH Host" dialog
            await vscode.commands.executeCommand('opensshremotes.addNewSshHost');
        } catch {
            try {
                // Alternative command
                await vscode.commands.executeCommand('remote-ssh.addNewSshHost');
            } catch {
                // If Remote-SSH commands aren't available, show instructions
                const action = await vscode.window.showWarningMessage(
                    'Remote-SSH extension is required to add SSH hosts. Would you like to install it?',
                    'Install Extension',
                    'Cancel'
                );
                if (action === 'Install Extension') {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode-remote.remote-ssh');
                }
            }
        }
    }

    /**
     * Create a job on a remote SSH host.
     * Stores the job session and refreshes the sidebar to show it
     * under Active / Pending Sessions.
     */
    private async createJob(hostName: string, cpus: string, memory: string, gpu: string, wallTime: string, queue: string, allocation: string) {
        const session: JobSession = {
            id: crypto.randomBytes(4).toString('hex'),
            host: hostName,
            cpus,
            memory,
            gpu,
            wallTime,
            queue,
            allocation,
            status: 'Pending',
            submittedAt: new Date(),
        };

        this._jobSessions.push(session);
        this.refresh();

        vscode.window.showInformationMessage(`Job submitted on ${hostName} — ${cpus} CPUs, ${memory}, GPU: ${gpu}, Wall: ${wallTime}, Queue: ${queue}, Allocation: ${allocation}`);
    }

    /**
     * Query SLURM associations for the current user on a remote host,
     * parse the account→QOS mapping, and send it to the webview
     * to populate the Allocation and Queue dropdowns.
     */
    private async queryAssociations(hostName: string) {
        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Querying SLURM associations on ${hostName} ---`);

        try {
            const result = await this.runRemoteCommand(hostName, 'sacctmgr show associations where user=$USER format=Cluster,Account,Partition,QOS -p');

            if (result.code === 0) {
                this._outputChannel.appendLine(result.stdout);

                // Parse pipe-delimited output into account → QOS mapping
                // Format: Cluster|Account|Partition|QOS|
                const lines = result.stdout.trim().split('\n');
                const associations: { [account: string]: string[] } = {};

                for (let i = 1; i < lines.length; i++) { // skip header
                    const parts = lines[i].split('|');
                    if (parts.length >= 4) {
                        const account = parts[1].trim();
                        const qosList = parts[3].trim().split(',').filter(q => q.length > 0);
                        if (account) {
                            associations[account] = qosList;
                        }
                    }
                }

                // Send to webview
                this.postMessage({ type: 'associations', host: hostName, associations });
            } else {
                this._outputChannel.appendLine(`Command exited with code ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
            }
            this._outputChannel.appendLine(`--- End of associations ---\n`);
        } catch (err: any) {
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to query associations on ${hostName}: ${err.message}`);
        }
    }

    /**
     * Connect to an SSH host using VS Code Remote-SSH
     */
    private async connectToSshHost(hostName: string) {
        // Prompt for the remote path
        const remotePath = await vscode.window.showInputBox({
            title: `Connect to ${hostName}`,
            prompt: 'Enter the remote folder path',
            placeHolder: '/home/user',
            value: '/home',
        });

        if (remotePath) {
            vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.from({
                    scheme: 'vscode-remote',
                    authority: `ssh-remote+${hostName}`,
                    path: remotePath,
                }),
                true // Open in new window
            );
        }
    }

    /**
     * Run a command on a remote SSH host.
     * Handles SSH_ASKPASS IPC for password/passphrase prompts and ControlMaster multiplexing.
     * Returns a promise that resolves with { stdout, stderr, code }.
     */
    private runRemoteCommand(hostName: string, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
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
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
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

    /**
     * List files on a remote SSH host and display in Output channel.
     */
    private async listRemoteFiles(hostName: string) {
        const remotePath = await vscode.window.showInputBox({
            title: `List files on ${hostName}`,
            prompt: 'Enter the remote directory path to list',
            placeHolder: '/home/user',
            value: '~',
        });

        if (!remotePath) {
            return;
        }

        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Listing files on ${hostName}:${remotePath} ---`);

        try {
            const result = await this.runRemoteCommand(hostName, `ls -la ${remotePath}`);

            if (result.code === 0) {
                this._outputChannel.appendLine(result.stdout);
                this._outputChannel.appendLine(`--- End of listing ---\n`);
            } else {
                this._outputChannel.appendLine(`SSH exited with code ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
                vscode.window.showErrorMessage(`Failed to list files on ${hostName} (exit code ${result.code})`);
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to run SSH: ${err.message}`);
        }
    }

    /**
     * Refresh the webview content
     */
    public refresh() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
        }
    }

    public postMessage(message: unknown) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Use a nonce to only allow a specific script to run
        const nonce = getNonce();

        // Get SSH hosts from config
        const sshHosts = this.getSshHosts();
        const hostsHtml = sshHosts.length > 0
            ? sshHosts.map(host => `
                <div class="ssh-host">
                    <div class="ssh-host-row">
                    <div class="host-info">
                        <span class="host-name">${escapeHtml(host.name)}</span>
                        ${host.hostname ? `<span class="host-detail">${escapeHtml(host.hostname)}</span>` : ''}
                        ${host.user ? `<span class="host-detail">@${escapeHtml(host.user)}</span>` : ''}
                    </div>
                    <div class="host-actions">
                        <button class="list-btn" data-host="${escapeHtml(host.name)}" title="List files">📁</button>
                        <button class="create-btn" data-host="${escapeHtml(host.name)}">Create</button>
                        <button class="connect-btn" data-host="${escapeHtml(host.name)}">Connect</button>
                    </div>
                    </div>
                    <div class="job-form" id="job-form-${escapeHtml(host.name)}" style="display:none;">
                        <div class="form-row">
                            <label>CPUs</label>
                            <select class="form-select" data-field="cpus">
                                <option value="1">1</option>
                                <option value="2">2</option>
                                <option value="4">4</option>
                                <option value="8">8</option>
                                <option value="16">16</option>
                                <option value="32">32</option>
                                <option value="64">64</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <label>Memory</label>
                            <select class="form-select" data-field="memory">
                                <option value="1 GB">1 GB</option>
                                <option value="2 GB">2 GB</option>
                                <option value="4 GB">4 GB</option>
                                <option value="8 GB">8 GB</option>
                                <option value="16 GB">16 GB</option>
                                <option value="32 GB">32 GB</option>
                                <option value="64 GB">64 GB</option>
                                <option value="128 GB">128 GB</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <label>GPU</label>
                            <select class="form-select" data-field="gpu">
                                <option value="None">None</option>
                                <option value="NVIDIA A100">NVIDIA A100</option>
                                <option value="NVIDIA V100">NVIDIA V100</option>
                                <option value="NVIDIA T4">NVIDIA T4</option>
                                <option value="NVIDIA A40">NVIDIA A40</option>
                                <option value="NVIDIA H100">NVIDIA H100</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <label>Wall Time</label>
                            <select class="form-select" data-field="wallTime">
                                <option value="00:30:00">30 min</option>
                                <option value="01:00:00">1 hour</option>
                                <option value="02:00:00">2 hours</option>
                                <option value="04:00:00">4 hours</option>
                                <option value="08:00:00">8 hours</option>
                                <option value="12:00:00">12 hours</option>
                                <option value="24:00:00">24 hours</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <label>Allocation</label>
                            <select class="form-select" data-field="allocation" data-host="${escapeHtml(host.name)}">
                                <option value="">Loading...</option>
                            </select>
                        </div>
                        <div class="form-row">
                            <label>Queue</label>
                            <select class="form-select" data-field="queue" data-host="${escapeHtml(host.name)}">
                                <option value="">Select allocation first</option>
                            </select>
                        </div>
                        <button class="submit-job-btn" data-host="${escapeHtml(host.name)}">Submit Job</button>
                    </div>
                </div>
            `).join('')
            : '<p class="empty-message">No SSH hosts found in ~/.ssh/config</p>';

        // Build sessions HTML
        const sessionsHtml = this._jobSessions.length > 0
            ? this._jobSessions.map(session => {
                const time = session.submittedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const statusIcon = session.status === 'Active' ? '🟢' : '🟡';
                return `
                <div class="session-entry">
                    <div class="session-row">
                        <div class="session-info">
                            <span class="session-name">${statusIcon} ${escapeHtml(session.host)}</span>
                            <span class="session-detail">${escapeHtml(session.cpus)} CPUs · ${escapeHtml(session.memory)} · GPU: ${escapeHtml(session.gpu)}</span>
                            <span class="session-detail">Queue: ${escapeHtml(session.queue)} · Alloc: ${escapeHtml(session.allocation)}</span>
                            <span class="session-detail">Wall: ${escapeHtml(session.wallTime)} · Submitted ${time}</span>
                        </div>
                        <div class="session-actions">
                            <button class="connect-session-btn" data-session-id="${escapeHtml(session.id)}" data-host="${escapeHtml(session.host)}">Connect</button>
                            <button class="remove-session-btn" data-session-id="${escapeHtml(session.id)}" title="Remove">✕</button>
                        </div>
                    </div>
                </div>`;
            }).join('')
            : '<p class="empty-message">No active sessions</p>';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle</title>
    <style>
        body {
            padding: 10px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        h2 {
            margin-top: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        h3 {
            margin: 16px 0 8px 0;
            font-size: 12px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        button {
            padding: 8px 12px;
            margin: 8px 0;
            border: none;
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 13px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .full-width {
            display: block;
            width: 100%;
        }
        .description {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-bottom: 16px;
        }
        .ssh-host {
            display: flex;
            flex-direction: column;
            padding: 8px;
            margin: 4px 0;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
        }
        .ssh-host > .host-info,
        .ssh-host > .host-actions {
            /* keep the top row as a horizontal strip */
        }
        .ssh-host-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .host-info {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .host-name {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .host-detail {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .connect-btn {
            margin: 0;
            padding: 4px 10px;
            font-size: 12px;
            flex-shrink: 0;
        }
        .create-btn {
            margin: 0 4px 0 0;
            padding: 4px 10px;
            font-size: 12px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .create-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .job-form {
            width: 100%;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .form-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
        }
        .form-row label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
            width: 70px;
        }
        .form-select {
            flex: 1;
            padding: 4px 6px;
            font-size: 12px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 3px;
            outline: none;
        }
        .form-select:focus {
            border-color: var(--vscode-focusBorder);
        }
        .submit-job-btn {
            width: 100%;
            margin: 6px 0 0 0;
            padding: 6px 10px;
            font-size: 12px;
        }
        .list-btn {
            margin: 0 4px 0 0;
            padding: 4px 8px;
            font-size: 12px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .list-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .host-actions {
            display: flex;
            flex-shrink: 0;
        }
        .empty-message {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 16px 0;
        }
        .refresh-btn {
            padding: 2px 8px;
            font-size: 11px;
            margin: 0;
        }
        .header-actions {
            display: flex;
            gap: 4px;
        }
        .section {
            margin-bottom: 20px;
        }
        .session-entry {
            padding: 8px;
            margin: 4px 0;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
        }
        .session-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .session-info {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .session-name {
            font-weight: 600;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .session-detail {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .session-actions {
            display: flex;
            flex-shrink: 0;
            gap: 4px;
        }
        .connect-session-btn {
            margin: 0;
            padding: 4px 10px;
            font-size: 12px;
            flex-shrink: 0;
        }
        .remove-session-btn {
            margin: 0;
            padding: 4px 8px;
            font-size: 12px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .remove-session-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <h2>CyberShuttle</h2>
    <p class="description">Connect to remote HPC workspaces</p>

    <div class="section">
        <button id="auth-btn" class="full-width">Authenticate</button>
        <button id="open-btn" class="full-width">Open Workspace</button>
    </div>

    <div class="section">
        <h3>
            Remote Servers
            <div class="header-actions">
                <button id="add-ssh-btn" class="refresh-btn" title="Add SSH Host">+ Add</button>
                <button id="refresh-btn" class="refresh-btn" title="Refresh">↻</button>
            </div>
        </h3>
        <div id="ssh-hosts">
            ${hostsHtml}
        </div>
    </div>

    <div class="section">
        <h3>Active / Pending Sessions</h3>
        <div id="sessions">
            ${sessionsHtml}
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        document.getElementById('auth-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'auth' });
        });

        document.getElementById('open-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'openWorkspace' });
        });

        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        document.getElementById('add-ssh-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'addSshHost' });
        });

        // Add click handlers to all connect buttons
        document.querySelectorAll('.connect-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                vscode.postMessage({ type: 'connectSsh', host: host });
            });
        });

        // Add click handlers to all list files buttons
        document.querySelectorAll('.list-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                vscode.postMessage({ type: 'listFiles', host: host });
            });
        });

        // Add click handlers to all create buttons (toggle form + query associations)
        document.querySelectorAll('.create-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (form) {
                    const isOpening = form.style.display === 'none';
                    form.style.display = isOpening ? 'block' : 'none';
                    if (isOpening) {
                        vscode.postMessage({ type: 'queryAssociations', host: host });
                    }
                }
            });
        });

        // Add click handlers to submit job buttons
        document.querySelectorAll('.submit-job-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (!form) { return; }
                const cpus = form.querySelector('[data-field="cpus"]').value;
                const memory = form.querySelector('[data-field="memory"]').value;
                const gpu = form.querySelector('[data-field="gpu"]').value;
                const wallTime = form.querySelector('[data-field="wallTime"]').value;
                const queue = form.querySelector('[data-field="queue"]').value;
                const allocation = form.querySelector('[data-field="allocation"]').value;
                vscode.postMessage({ type: 'createJob', host: host, cpus: cpus, memory: memory, gpu: gpu, wallTime: wallTime, queue: queue, allocation: allocation });
            });
        });

        // Add click handlers to session connect buttons
        document.querySelectorAll('.connect-session-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.getAttribute('data-host');
                vscode.postMessage({ type: 'connectSsh', host: host });
            });
        });

        // Add click handlers to session remove buttons
        document.querySelectorAll('.remove-session-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sessionId = btn.getAttribute('data-session-id');
                vscode.postMessage({ type: 'removeSession', sessionId: sessionId });
            });
        });

        // Handle messages from the extension (e.g. associations data)
        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'associations') {
                const host = msg.host;
                const associations = msg.associations; // { account: [qos1, qos2, ...], ... }
                const form = document.getElementById('job-form-' + host);
                if (!form) { return; }

                const allocSelect = form.querySelector('[data-field="allocation"]');
                const queueSelect = form.querySelector('[data-field="queue"]');

                // Populate Allocation dropdown
                allocSelect.innerHTML = '';
                const accounts = Object.keys(associations);
                if (accounts.length === 0) {
                    allocSelect.innerHTML = '<option value="">No allocations found</option>';
                    queueSelect.innerHTML = '<option value="">N/A</option>';
                    return;
                }
                accounts.forEach((acct, i) => {
                    const opt = document.createElement('option');
                    opt.value = acct;
                    opt.textContent = acct;
                    if (i === 0) { opt.selected = true; }
                    allocSelect.appendChild(opt);
                });

                // Update Queue dropdown based on selected allocation
                function updateQueues() {
                    const selectedAcct = allocSelect.value;
                    const qosList = associations[selectedAcct] || [];
                    queueSelect.innerHTML = '';
                    if (qosList.length === 0) {
                        queueSelect.innerHTML = '<option value="">No queues available</option>';
                        return;
                    }
                    qosList.forEach((qos, i) => {
                        const opt = document.createElement('option');
                        opt.value = qos;
                        opt.textContent = qos;
                        if (i === 0) { opt.selected = true; }
                        queueSelect.appendChild(opt);
                    });
                }

                allocSelect.addEventListener('change', updateQueues);
                updateQueues(); // populate for initial selection
            }
        });
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

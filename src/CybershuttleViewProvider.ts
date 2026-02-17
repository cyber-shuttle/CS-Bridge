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

export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cybershuttle.sidebarView';

    private _view?: vscode.WebviewView;
    private _outputChannel: vscode.OutputChannel;
    private _sshControlDir: string;

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
     * List files on a remote SSH host and display in Output channel.
     * Shows password/passphrase prompts as VS Code input boxes (like Remote-SSH)
     * using an SSH_ASKPASS helper script for IPC.
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
            `ls -la ${remotePath}`
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
        // Track prompt files we've already handled
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

                    // Mark as handled immediately to prevent duplicate input boxes
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
            if (code === 0) {
                this._outputChannel.appendLine(stdoutData);
                this._outputChannel.appendLine(`--- End of listing ---\n`);
            } else {
                this._outputChannel.appendLine(`SSH exited with code ${code}`);
                if (stderrData) {
                    this._outputChannel.appendLine(stderrData);
                }
                vscode.window.showErrorMessage(`Failed to list files on ${hostName} (exit code ${code})`);
            }
        });

        sshProcess.on('error', (err: Error) => {
            cleanup();
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to run SSH: ${err.message}`);
        });
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
                    <div class="host-info">
                        <span class="host-name">${escapeHtml(host.name)}</span>
                        ${host.hostname ? `<span class="host-detail">${escapeHtml(host.hostname)}</span>` : ''}
                        ${host.user ? `<span class="host-detail">@${escapeHtml(host.user)}</span>` : ''}
                    </div>
                    <div class="host-actions">
                        <button class="list-btn" data-host="${escapeHtml(host.name)}" title="List files">📁</button>
                        <button class="connect-btn" data-host="${escapeHtml(host.name)}">Connect</button>
                    </div>
                </div>
            `).join('')
            : '<p class="empty-message">No SSH hosts found in ~/.ssh/config</p>';

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
            justify-content: space-between;
            align-items: center;
            padding: 8px;
            margin: 4px 0;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
        }
        .ssh-host:hover {
            background: var(--vscode-list-activeSelectionBackground);
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
            SSH Connections
            <div class="header-actions">
                <button id="add-ssh-btn" class="refresh-btn" title="Add SSH Host">+ Add</button>
                <button id="refresh-btn" class="refresh-btn" title="Refresh">↻</button>
            </div>
        </h3>
        <div id="ssh-hosts">
            ${hostsHtml}
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

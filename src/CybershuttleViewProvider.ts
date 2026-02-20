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
    status: 'Pending' | 'Active' | 'Submitting' | 'Failed';
    submittedAt: Date;
    slurmJobId?: string;
    script?: string;
}

export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cybershuttle.sidebarView';

    private _view?: vscode.WebviewView;
    private _outputChannel: vscode.OutputChannel;
    private _sshControlDir: string;
    private _jobSessions: JobSession[] = [];
    private _activeTab: string = 'servers';

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
                case 'browseDir': {
                    this.browseRemoteDir(data.host, data.path);
                    break;
                }
                case 'refresh': {
                    this.refresh();
                    break;
                }
                case 'switchTab': {
                    this._activeTab = data.tab;
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
                case 'refreshSessions': {
                    this.refreshSessions();
                    break;
                }
                case 'relaunchSession': {
                    this.relaunchSession(data.sessionId);
                    break;
                }
                case 'removeSession': {
                    this._jobSessions = this._jobSessions.filter(s => s.id !== data.sessionId);
                    this.refresh();
                    break;
                }
                case 'confirmJob': {
                    this.submitJob(data.sessionId);
                    break;
                }
                case 'cancelJob': {
                    this.cancelJobPreview(data.sessionId);
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
     * Generates a SLURM script and sends it to the webview for preview
     * before actual submission.
     */
    private async createJob(hostName: string, cpus: string, memory: string, gpu: string, wallTime: string, queue: string, allocation: string) {
        const sessionId = crypto.randomBytes(4).toString('hex');
        const script = this.generateSlurmScript({ cpus, memory, gpu, wallTime, queue, allocation });

        const session: JobSession = {
            id: sessionId,
            host: hostName,
            cpus,
            memory,
            gpu,
            wallTime,
            queue,
            allocation,
            status: 'Pending',
            submittedAt: new Date(),
            script,
        };

        // Store the session (not yet submitted) and send preview to webview
        this._jobSessions.push(session);
        this.postMessage({ type: 'scriptPreview', sessionId, host: hostName, script });
    }

    /**
     * Generate a SLURM batch script from job parameters.
     * The script downloads linkspan, embeds a workflow YAML, and pipes it
     * to linkspan via stdin heredoc.
     */
    private generateSlurmScript(params: {
        cpus: string;
        memory: string;
        gpu: string;
        wallTime: string;
        queue: string;
        allocation: string;
    }): string {
        const { cpus, memory, gpu, wallTime, queue, allocation } = params;

        // Parse memory value (e.g. "8 GB" → "8G")
        const memSlurm = memory.replace(/\s+/g, '');

        // Build #SBATCH lines
        const sbatchLines = [
            `#SBATCH --job-name=linkspan-session`,
            `#SBATCH --ntasks=1`,
            `#SBATCH --cpus-per-task=${cpus}`,
            `#SBATCH --mem=${memSlurm}`,
            `#SBATCH --time=${wallTime}`,
            `#SBATCH --partition=${queue}`,
            `#SBATCH --account=${allocation}`,
        ];

        // Add GPU if selected
        if (gpu !== 'None') {
            // Map display name to SLURM gres tag (e.g. "NVIDIA A100" → "gpu:a100:1")
            const gpuTag = gpu.replace('NVIDIA ', '').toLowerCase();
            sbatchLines.push(`#SBATCH --gres=gpu:${gpuTag}:1`);
        }

        const linkspanVersion = 'v0.3.0';
        const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/download/${linkspanVersion}/linkspan_Linux_x86_64.tar.gz`;

        // Build the workflow YAML that will be passed to linkspan via stdin
        const workflowYaml = [
            `name: "cs-bridge-hpc-setup"`,
            ``,
            `steps:`,
            `  - action: "vscode.create_session"`,
            `    name: "Start SSH server"`,
            `    params:`,
            `      password: "test"`,
            `    outputs:`,
            `      bind_port: "ssh_port"`,
            ``,
            `  - action: "tunnel.devtunnel_create"`,
            `    name: "Create devtunnel"`,
            `    params:`,
            `      tunnel_name: "linkspan-tunnel"`,
            `      expiration: "1d"`,
            `      ports:`,
            `        - "{{.ssh_port}}"`,
            ``,
            `  - action: "tunnel.devtunnel_host"`,
            `    name: "Host devtunnel"`,
            `    params:`,
            `      tunnel_name: "linkspan-tunnel"`,
            `      create_token: true`,
        ].join('\n');

        const script = [
            `#!/bin/bash`,
            ...sbatchLines,
            ``,
            `# --- Download linkspan ---`,
            `LINKSPAN_DIR="$(mktemp -d)"`,
            `wget -q "${downloadUrl}" -O "$LINKSPAN_DIR/linkspan.tar.gz"`,
            `tar -xzf "$LINKSPAN_DIR/linkspan.tar.gz" -C "$LINKSPAN_DIR"`,
            `chmod +x "$LINKSPAN_DIR/linkspan"`,
            ``,
            `# --- Run linkspan with workflow from stdin ---`,
            `"$LINKSPAN_DIR/linkspan" --workflow - <<'WORKFLOW_EOF'`,
            workflowYaml,
            `WORKFLOW_EOF`,
        ].join('\n');

        return script;
    }

    /**
     * Submit a previously previewed SLURM job via sbatch over SSH.
     */
    private async submitJob(sessionId: string) {
        const session = this._jobSessions.find(s => s.id === sessionId);
        if (!session || !session.script) {
            vscode.window.showErrorMessage('Session not found or script missing.');
            return;
        }

        session.status = 'Submitting';
        this.refresh();

        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Submitting SLURM job on ${session.host} ---`);

        try {
            // Base64-encode the script to avoid quoting issues over SSH
            const scriptB64 = Buffer.from(session.script).toString('base64');
            const result = await this.runRemoteCommand(
                session.host,
                `echo '${scriptB64}' | base64 -d | sbatch`
            );

            if (result.code === 0) {
                // sbatch typically outputs "Submitted batch job <id>"
                const match = result.stdout.match(/Submitted batch job (\d+)/);
                session.slurmJobId = match ? match[1] : undefined;
                session.status = 'Pending';
                this._outputChannel.appendLine(result.stdout);
                this._activeTab = 'sessions';
                vscode.window.showInformationMessage(
                    `SLURM job submitted on ${session.host}${session.slurmJobId ? ` (Job ID: ${session.slurmJobId})` : ''}`
                );
            } else {
                session.status = 'Failed';
                this._outputChannel.appendLine(`sbatch exited with code ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
                vscode.window.showErrorMessage(`Failed to submit job on ${session.host}: ${result.stderr || `exit code ${result.code}`}`);
            }
        } catch (err: any) {
            session.status = 'Failed';
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to submit job: ${err.message}`);
        }

        this.refresh();
    }

    /**
     * Relaunch a failed session by resubmitting its script.
     */
    private async relaunchSession(sessionId: string) {
        const session = this._jobSessions.find(s => s.id === sessionId);
        if (!session || !session.script) {
            vscode.window.showErrorMessage('Session not found or script missing.');
            return;
        }
        session.slurmJobId = undefined;
        await this.submitJob(sessionId);
    }

    /**
     * Cancel a pending job preview (remove the session that was created during preview).
     */
    private cancelJobPreview(sessionId: string) {
        this._jobSessions = this._jobSessions.filter(s => s.id !== sessionId);
        this.postMessage({ type: 'scriptPreviewDismissed' });
    }

    /**
     * Refresh session statuses by querying squeue on the remote host.
     * RUNNING → Active, PENDING → Pending, no output → completed/removed.
     */
    private async refreshSessions() {
        const sessionsWithJobs = this._jobSessions.filter(s => s.slurmJobId);
        if (sessionsWithJobs.length === 0) {
            this.refresh();
            return;
        }

        for (const session of sessionsWithJobs) {
            try {
                const result = await this.runRemoteCommand(
                    session.host,
                    `squeue -j ${session.slurmJobId} -h -o "%T"`
                );

                const state = result.stdout.trim();
                if (result.code === 0 && state) {
                    if (state === 'RUNNING') {
                        session.status = 'Active';
                    } else if (state === 'PENDING') {
                        session.status = 'Pending';
                    } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT' || state === 'NODE_FAIL' || state === 'OUT_OF_MEMORY') {
                        session.status = 'Failed';
                    }
                } else {
                    // Job no longer in queue — mark as failed
                    if (session.status !== 'Active') {
                        session.status = 'Failed';
                    }
                }
            } catch {
                // SSH error — leave session as-is
            }
        }

        this.refresh();
    }

    /**
     * Query SLURM partition and account info for the current user on a remote host
     * using scripts/info.sh. Sends a partition→info mapping to the webview
     * to populate the Partition and Allocation dropdowns.
     */
    private async queryAssociations(hostName: string) {
        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Querying SLURM partition info on ${hostName} ---`);

        try {
            // Read the info.sh script and run it remotely via base64 pipe
            const infoScript = fs.readFileSync(
                path.join(this._extensionUri.fsPath, 'scripts', 'info.sh'),
                'utf-8'
            );
            const scriptB64 = Buffer.from(infoScript).toString('base64');
            const result = await this.runRemoteCommand(
                hostName,
                `echo '${scriptB64}' | base64 -d | bash`
            );

            if (result.code === 0) {
                this._outputChannel.appendLine(result.stdout);

                // Parse pipe-delimited output into partition → info mapping
                // Format: partition|nodes|max_cpus_per_node|max_gpus_per_node|accounts
                const lines = result.stdout.trim().split('\n');
                const partitions: { [name: string]: { accounts: string[]; nodes: number; maxCpus: number; maxGpus: number } } = {};

                for (let i = 1; i < lines.length; i++) { // skip header
                    const parts = lines[i].split('|');
                    if (parts.length >= 5) {
                        const name = parts[0].trim();
                        const nodes = parseInt(parts[1].trim(), 10) || 0;
                        const maxCpus = parseInt(parts[2].trim(), 10) || 0;
                        const maxGpus = parseInt(parts[3].trim(), 10) || 0;
                        const accounts = parts[4].trim().split(',').filter(a => a.length > 0);
                        if (name) {
                            partitions[name] = { accounts, nodes, maxCpus, maxGpus };
                        }
                    }
                }

                // Send to webview
                this.postMessage({ type: 'associations', host: hostName, partitions });
            } else {
                this._outputChannel.appendLine(`Command exited with code ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
            }
            this._outputChannel.appendLine(`--- End of partition info ---\n`);
        } catch (err: any) {
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to query partition info on ${hostName}: ${err.message}`);
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
     * Browse a directory on a remote SSH host.
     * Parses ls output into structured entries and sends to the webview.
     */
    private async browseRemoteDir(hostName: string, remotePath: string) {
        this.postMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: true, entries: [] });

        try {
            // Resolve path (e.g. ~) and get structured listing
            const result = await this.runRemoteCommand(
                hostName,
                `cd ${remotePath} && pwd && ls -lAhp`
            );

            if (result.code === 0) {
                const lines = result.stdout.split('\n');
                const resolvedPath = lines[0].trim();
                const entries: { name: string; isDir: boolean; size: string }[] = [];

                // Skip the "total ..." line (line index 1), parse the rest
                for (let i = 2; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) { continue; }
                    // ls -lAhp format: perms links owner group size month day time name
                    const parts = line.split(/\s+/);
                    if (parts.length < 9) { continue; }
                    const size = parts[4];
                    const name = parts.slice(8).join(' ');
                    if (name === './' || name === '../') { continue; }
                    const isDir = name.endsWith('/');
                    entries.push({ name: isDir ? name.slice(0, -1) : name, isDir, size });
                }

                // Sort: directories first, then alphabetical
                entries.sort((a, b) => {
                    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
                    return a.name.localeCompare(b.name);
                });

                this.postMessage({ type: 'fileListing', host: hostName, path: resolvedPath, loading: false, entries });
            } else {
                this.postMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: false, entries: [], error: result.stderr || `exit code ${result.code}` });
            }
        } catch (err: any) {
            this.postMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: false, entries: [], error: err.message });
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
                    <div class="ssh-host-row" data-host="${escapeHtml(host.name)}">
                        <div class="host-info">
                            <span class="host-name">${escapeHtml(host.name)}</span>
                            ${host.hostname ? `<span class="host-detail">${host.user ? `${escapeHtml(host.user)}@` : ''}${escapeHtml(host.hostname)}</span>` : ''}
                        </div>
                        <span class="chevron">&#9662;</span>
                    </div>
                    <div class="job-form" id="job-form-${escapeHtml(host.name)}" style="display:none;">
                        <div class="job-form-loading"><div class="spinner"></div>Fetching partitions...</div>
                        <div class="job-form-fields">
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
                                <label>Partition</label>
                                <select class="form-select" data-field="queue" data-host="${escapeHtml(host.name)}">
                                    <option value="">Select allocation first</option>
                                </select>
                            </div>
                            <button class="submit-job-btn" data-host="${escapeHtml(host.name)}">Launch</button>
                        </div>
                    </div>
                </div>
            `).join('')
            : '<p class="empty-message">No SSH hosts found in ~/.ssh/config</p>';

        // Build sessions HTML
        const sessionsHtml = this._jobSessions.length > 0
            ? this._jobSessions.map(session => {
                const time = session.submittedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const statusIcon = session.status === 'Active' ? '🟢' : session.status === 'Failed' ? '🔴' : session.status === 'Submitting' ? '🔵' : '🟡';
                return `
                <div class="session-entry">
                    <div class="session-row">
                        <div class="session-info">
                            <span class="session-name">${statusIcon} ${escapeHtml(session.host)}</span>
                            <span class="session-detail">${escapeHtml(session.cpus)} CPUs · ${escapeHtml(session.memory)} · GPU: ${escapeHtml(session.gpu)}</span>
                            <span class="session-detail">Partition: ${escapeHtml(session.queue)} · Alloc: ${escapeHtml(session.allocation)}</span>
                            <span class="session-detail">Wall: ${escapeHtml(session.wallTime)} · Submitted ${time}${session.slurmJobId ? ` · Job ${escapeHtml(session.slurmJobId)}` : ''}</span>
                        </div>
                        <div class="session-actions">
                            ${session.status === 'Failed'
                                ? `<button class="relaunch-session-btn" data-session-id="${escapeHtml(session.id)}">Relaunch</button>`
                                : `<button class="connect-session-btn" data-session-id="${escapeHtml(session.id)}" data-host="${escapeHtml(session.host)}"${session.status !== 'Active' ? ' disabled' : ''}>Connect</button>`
                            }
                            <button class="remove-session-btn" data-session-id="${escapeHtml(session.id)}" title="Remove">✕</button>
                        </div>
                    </div>
                </div>`;
            }).join('')
            : '<p class="empty-message">No active sessions</p>';

        const filesHtml = sshHosts.length > 0
            ? sshHosts.map(host => `
                <div class="ssh-host">
                    <div class="ssh-host-row file-host-row" data-host="${escapeHtml(host.name)}">
                        <div class="host-info">
                            <span class="host-name">${escapeHtml(host.name)}</span>
                            ${host.hostname ? `<span class="host-detail">${host.user ? `${escapeHtml(host.user)}@` : ''}${escapeHtml(host.hostname)}</span>` : ''}
                        </div>
                        <span class="chevron">&#9662;</span>
                    </div>
                    <div class="file-browser" id="file-browser-${escapeHtml(host.name)}" style="display:none;">
                        <div class="file-breadcrumbs" id="file-breadcrumbs-${escapeHtml(host.name)}"></div>
                        <div class="file-list" id="file-list-${escapeHtml(host.name)}"></div>
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
            padding: 5px 8px;
            margin: 2px 0;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
        }
        .ssh-host-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
        }
        .host-info {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .host-name {
            font-weight: 600;
            font-size: 12px;
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
        .chevron {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.15s ease;
            flex-shrink: 0;
        }
        .ssh-host-row.expanded .chevron {
            transform: rotate(180deg);
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
        .job-form-loading {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 0;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-descriptionForeground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .job-form-fields {
            display: none;
        }
        .file-browser {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .file-breadcrumbs {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 2px;
            font-size: 11px;
            margin-bottom: 6px;
            color: var(--vscode-descriptionForeground);
        }
        .breadcrumb-seg {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            padding: 1px 2px;
            border-radius: 2px;
        }
        .breadcrumb-seg:hover {
            text-decoration: underline;
        }
        .breadcrumb-sep {
            color: var(--vscode-descriptionForeground);
        }
        .file-list {
            max-height: 260px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .file-entry {
            display: flex;
            align-items: center;
            padding: 3px 8px;
            font-size: 11px;
            border-bottom: 1px solid var(--vscode-panel-border);
            gap: 6px;
        }
        .file-entry:last-child {
            border-bottom: none;
        }
        .file-entry.dir {
            cursor: pointer;
        }
        .file-entry.dir:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .file-icon {
            flex-shrink: 0;
            width: 14px;
            text-align: center;
        }
        .file-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-size {
            flex-shrink: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
        }
        .file-list-loading {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .file-list-error {
            padding: 8px;
            font-size: 11px;
            color: var(--vscode-errorForeground);
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
        .tab-row {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
            gap: 0;
        }
        .tab-btn {
            flex: 1;
            padding: 6px 0;
            margin: 0;
            border: none;
            border-bottom: 2px solid transparent;
            border-radius: 0;
            background: none;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            text-transform: uppercase;
            cursor: pointer;
            text-align: center;
        }
        .tab-btn:hover {
            background: none;
            color: var(--vscode-foreground);
        }
        .tab-btn.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder);
            font-weight: 600;
        }
        .tab-panel {
            display: none;
        }
        .tab-panel.active {
            display: block;
        }
        .tab-header {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 6px;
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
        .connect-session-btn:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .relaunch-session-btn {
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
        .script-preview-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: var(--vscode-editor-background);
            z-index: 100;
            padding: 10px;
            overflow-y: auto;
            flex-direction: column;
        }
        .script-preview-overlay.visible {
            display: flex;
        }
        .script-preview-header {
            font-weight: 600;
            font-size: 13px;
            margin-bottom: 8px;
        }
        .script-preview-host {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .script-preview-code {
            flex: 1;
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px;
            line-height: 1.4;
            white-space: pre;
            overflow: auto;
            color: var(--vscode-editor-foreground);
        }
        .script-preview-actions {
            display: flex;
            gap: 8px;
            margin-top: 10px;
        }
        .script-preview-actions button {
            flex: 1;
            margin: 0;
        }
        .cancel-preview-btn {
            background: var(--vscode-button-secondaryBackground) !important;
            color: var(--vscode-button-secondaryForeground) !important;
        }
        .cancel-preview-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground) !important;
        }
    </style>
</head>
<body>
    <h2>CyberShuttle</h2>
    <p class="description">Connect to remote HPC workspaces</p>

    <div class="tab-row">
        <button class="tab-btn${this._activeTab === 'servers' ? ' active' : ''}" data-tab="servers">Servers</button>
        <button class="tab-btn${this._activeTab === 'sessions' ? ' active' : ''}" data-tab="sessions">Sessions</button>
        <button class="tab-btn${this._activeTab === 'files' ? ' active' : ''}" data-tab="files">Files</button>
    </div>

    <div id="tab-servers" class="tab-panel${this._activeTab === 'servers' ? ' active' : ''}">
        <div class="tab-header">
            <button id="add-ssh-btn" class="refresh-btn" title="Add SSH Host">+ Add</button>
            <button id="refresh-btn" class="refresh-btn" title="Refresh">↻</button>
        </div>
        <div id="ssh-hosts">
            ${hostsHtml}
        </div>
    </div>

    <div id="tab-sessions" class="tab-panel${this._activeTab === 'sessions' ? ' active' : ''}">
        <div class="tab-header">
            <button id="refresh-sessions-btn" class="refresh-btn" title="Refresh Sessions">↻</button>
        </div>
        <div id="sessions">
            ${sessionsHtml}
        </div>
    </div>

    <div id="tab-files" class="tab-panel${this._activeTab === 'files' ? ' active' : ''}">
        <div id="file-hosts">
            ${filesHtml}
        </div>
    </div>

    <!-- Script preview overlay -->
    <div id="script-preview-overlay" class="script-preview-overlay">
        <div class="script-preview-header">SLURM Job Script Preview</div>
        <div id="script-preview-host" class="script-preview-host"></div>
        <div id="script-preview-code" class="script-preview-code"></div>
        <div class="script-preview-actions">
            <button id="cancel-preview-btn" class="cancel-preview-btn">Cancel</button>
            <button id="confirm-preview-btn">Submit Job</button>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('tab-' + tab).classList.add('active');
                vscode.postMessage({ type: 'switchTab', tab: tab });
            });
        });

        document.getElementById('refresh-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        document.getElementById('add-ssh-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'addSshHost' });
        });

        document.getElementById('refresh-sessions-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refreshSessions' });
        });

        // File browser accordion (only one open at a time)
        document.querySelectorAll('.file-host-row').forEach(row => {
            row.addEventListener('click', () => {
                const host = row.getAttribute('data-host');
                const browser = document.getElementById('file-browser-' + host);
                if (browser) {
                    const isOpening = browser.style.display === 'none';
                    document.querySelectorAll('.file-browser').forEach(b => b.style.display = 'none');
                    document.querySelectorAll('.file-host-row').forEach(r => r.classList.remove('expanded'));
                    if (isOpening) {
                        browser.style.display = 'block';
                        row.classList.add('expanded');
                        vscode.postMessage({ type: 'browseDir', host: host, path: '~' });
                    }
                }
            });
        });

        // Add click handlers to host rows (accordion — only one open at a time)
        document.querySelectorAll('#ssh-hosts .ssh-host-row').forEach(row => {
            row.addEventListener('click', () => {
                const host = row.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (form) {
                    const isOpening = form.style.display === 'none';
                    // Collapse all open forms and reset chevrons
                    document.querySelectorAll('.job-form').forEach(f => f.style.display = 'none');
                    document.querySelectorAll('#ssh-hosts .ssh-host-row').forEach(r => r.classList.remove('expanded'));
                    if (isOpening) {
                        form.style.display = 'block';
                        row.classList.add('expanded');
                        form.querySelector('.job-form-loading').style.display = 'flex';
                        form.querySelector('.job-form-fields').style.display = 'none';
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

        // Add click handlers to session relaunch buttons
        document.querySelectorAll('.relaunch-session-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sessionId = btn.getAttribute('data-session-id');
                vscode.postMessage({ type: 'relaunchSession', sessionId: sessionId });
            });
        });

        // Add click handlers to session remove buttons
        document.querySelectorAll('.remove-session-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sessionId = btn.getAttribute('data-session-id');
                vscode.postMessage({ type: 'removeSession', sessionId: sessionId });
            });
        });

        // Script preview state
        let previewSessionId = null;

        document.getElementById('confirm-preview-btn').addEventListener('click', () => {
            if (previewSessionId) {
                vscode.postMessage({ type: 'confirmJob', sessionId: previewSessionId });
                document.getElementById('script-preview-overlay').classList.remove('visible');
                previewSessionId = null;
            }
        });

        document.getElementById('cancel-preview-btn').addEventListener('click', () => {
            if (previewSessionId) {
                vscode.postMessage({ type: 'cancelJob', sessionId: previewSessionId });
            }
            document.getElementById('script-preview-overlay').classList.remove('visible');
            previewSessionId = null;
        });

        // Handle messages from the extension (e.g. associations data, script preview)
        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'scriptPreview') {
                previewSessionId = msg.sessionId;
                document.getElementById('script-preview-host').textContent = 'Host: ' + msg.host;
                document.getElementById('script-preview-code').textContent = msg.script;
                document.getElementById('script-preview-overlay').classList.add('visible');
                return;
            }

            if (msg.type === 'scriptPreviewDismissed') {
                document.getElementById('script-preview-overlay').classList.remove('visible');
                previewSessionId = null;
                return;
            }

            if (msg.type === 'associations') {
                const host = msg.host;
                const partitions = msg.partitions; // { name: { accounts, nodes, maxCpus, maxGpus } }
                const form = document.getElementById('job-form-' + host);
                if (!form) { return; }

                form.querySelector('.job-form-loading').style.display = 'none';
                form.querySelector('.job-form-fields').style.display = 'block';

                const allocSelect = form.querySelector('[data-field="allocation"]');
                const partSelect = form.querySelector('[data-field="queue"]');

                // Build account → partitions reverse mapping
                const accountPartitions = {};
                for (const [partName, info] of Object.entries(partitions)) {
                    for (const acct of info.accounts) {
                        if (!accountPartitions[acct]) { accountPartitions[acct] = []; }
                        accountPartitions[acct].push(partName);
                    }
                }

                // Populate Allocation dropdown
                allocSelect.innerHTML = '';
                const accounts = Object.keys(accountPartitions);
                if (accounts.length === 0) {
                    allocSelect.innerHTML = '<option value="">No allocations found</option>';
                    partSelect.innerHTML = '<option value="">N/A</option>';
                    return;
                }
                accounts.forEach((acct, i) => {
                    const opt = document.createElement('option');
                    opt.value = acct;
                    opt.textContent = acct;
                    if (i === 0) { opt.selected = true; }
                    allocSelect.appendChild(opt);
                });

                // Update Partition dropdown based on selected allocation
                function updatePartitions() {
                    const selectedAcct = allocSelect.value;
                    const parts = accountPartitions[selectedAcct] || [];
                    partSelect.innerHTML = '';
                    if (parts.length === 0) {
                        partSelect.innerHTML = '<option value="">No partitions available</option>';
                        return;
                    }
                    parts.forEach((name, i) => {
                        const info = partitions[name];
                        const label = info.maxGpus > 0
                            ? name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs, ' + info.maxGpus + ' GPUs)'
                            : name + ' (' + info.nodes + ' Nodes, ' + info.maxCpus + ' CPUs)';
                        const opt = document.createElement('option');
                        opt.value = name;
                        opt.textContent = label;
                        if (i === 0) { opt.selected = true; }
                        partSelect.appendChild(opt);
                    });
                }

                allocSelect.addEventListener('change', updatePartitions);
                updatePartitions(); // populate for initial selection
            }

            if (msg.type === 'fileListing') {
                const host = msg.host;
                const breadcrumbsEl = document.getElementById('file-breadcrumbs-' + host);
                const listEl = document.getElementById('file-list-' + host);
                if (!breadcrumbsEl || !listEl) { return; }

                if (msg.loading) {
                    breadcrumbsEl.innerHTML = '';
                    listEl.innerHTML = '<div class="file-list-loading"><div class="spinner"></div>Loading...</div>';
                    return;
                }

                if (msg.error) {
                    listEl.innerHTML = '<div class="file-list-error">Error: ' + msg.error + '</div>';
                    return;
                }

                // Build breadcrumbs
                const pathStr = msg.path;
                const segments = pathStr.split('/').filter(s => s.length > 0);
                let bc = '<span class="breadcrumb-seg" data-path="/" data-host="' + host + '">/</span>';
                let cumulative = '';
                segments.forEach(seg => {
                    cumulative += '/' + seg;
                    bc += '<span class="breadcrumb-sep">/</span>';
                    bc += '<span class="breadcrumb-seg" data-path="' + cumulative + '" data-host="' + host + '">' + seg + '</span>';
                });
                breadcrumbsEl.innerHTML = bc;

                // Attach breadcrumb click handlers
                breadcrumbsEl.querySelectorAll('.breadcrumb-seg').forEach(seg => {
                    seg.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'browseDir', host: seg.getAttribute('data-host'), path: seg.getAttribute('data-path') });
                    });
                });

                // Build file list
                if (msg.entries.length === 0) {
                    listEl.innerHTML = '<div class="file-list-loading">Empty directory</div>';
                    return;
                }

                listEl.innerHTML = msg.entries.map(entry => {
                    const icon = entry.isDir ? '&#128193;' : '&#128196;';
                    const cls = entry.isDir ? 'file-entry dir' : 'file-entry';
                    const entryPath = pathStr + (pathStr.endsWith('/') ? '' : '/') + entry.name;
                    return '<div class="' + cls + '"'
                        + (entry.isDir ? ' data-host="' + host + '" data-path="' + entryPath + '"' : '')
                        + '><span class="file-icon">' + icon + '</span>'
                        + '<span class="file-name">' + entry.name + '</span>'
                        + '<span class="file-size">' + entry.size + '</span></div>';
                }).join('');

                // Attach folder click handlers
                listEl.querySelectorAll('.file-entry.dir').forEach(entry => {
                    entry.addEventListener('click', () => {
                        vscode.postMessage({ type: 'browseDir', host: entry.getAttribute('data-host'), path: entry.getAttribute('data-path') });
                    });
                });
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

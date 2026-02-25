import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';

interface PersistentShell {
    process: ChildProcess;
    host: string;
    ready: Promise<void>;
    pending?: {
        resolve: (result: { stdout: string; code: number }) => void;
        reject: (err: Error) => void;
        marker: string;
        stdout: string;
        gotExit: boolean;
        exitCode: number;
        gotEnd: boolean;
    };
}

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
    status: 'Pending' | 'Active' | 'Submitting' | 'Failed' | 'Completed';
    submittedAt: Date;
    slurmJobId?: string;
    script?: string;
    errorMessage?: string;
    isLocal?: boolean;
    localPid?: number;
    tunnelUrl?: string;
    tunnelToken?: string;
    tunnelId?: string;
    sshPort?: number;
}

export class CybershuttleViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cybershuttle.sidebarView';

    private _view?: vscode.WebviewView;
    private _outputChannel: vscode.OutputChannel;
    private _sshControlDir: string;
    private _jobSessions: JobSession[] = [];
    private _activeTab: string = 'servers';
    private _globalState: vscode.Memento;
    private _persistentShells: Map<string, PersistentShell> = new Map();
    private _logTailProcesses: Map<string, ChildProcess> = new Map();
    private _browseRequestId: Map<string, number> = new Map();
    private _localProcesses: Map<string, ChildProcess> = new Map();

    private static readonly SESSIONS_KEY = 'cybershuttle.jobSessions';

    constructor(private readonly _extensionUri: vscode.Uri, globalState: vscode.Memento) {
        this._globalState = globalState;
        this._outputChannel = vscode.window.createOutputChannel('CyberShuttle');
        // Short path to stay under macOS 104-byte Unix socket limit
        this._sshControlDir = path.join(os.homedir(), '.cs-ssh');
        if (!fs.existsSync(this._sshControlDir)) {
            fs.mkdirSync(this._sshControlDir, { mode: 0o700 });
        }
        this._loadSessions();
    }

    private _loadSessions() {
        const raw = this._globalState.get<any[]>(CybershuttleViewProvider.SESSIONS_KEY, []);
        this._jobSessions = raw.map(s => ({
            ...s,
            submittedAt: new Date(s.submittedAt),
        }));
    }

    private _saveSessions() {
        this._globalState.update(CybershuttleViewProvider.SESSIONS_KEY, this._jobSessions);
    }

    /**
     * Get or create a persistent SSH shell for a host.
     * The shell stays alive for fast sequential command execution (file browsing).
     */
    private _getOrCreateShell(hostName: string): PersistentShell {
        const existing = this._persistentShells.get(hostName);
        if (existing && !existing.process.killed) {
            return existing;
        }

        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));
        const cancelFile = path.join(sessionDir, 'cancel');
        const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');

        const proc = spawn('ssh', [
            ...this.getControlMasterArgs(hostName),
            '-o', 'NumberOfPasswordPrompts=3',
            '-o', 'ServerAliveInterval=30',
            '-o', 'ServerAliveCountMax=3',
            hostName,
            'sh', // non-interactive shell
        ], {
            env: {
                ...process.env,
                SSH_ASKPASS: askpassScript,
                SSH_ASKPASS_REQUIRE: 'force',
                CS_ASKPASS_DIR: sessionDir,
                DISPLAY: ':0',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Ready resolves once the shell has produced its first prompt marker
        const readyMarker = `__CS_READY_${crypto.randomBytes(4).toString('hex')}__`;
        let resolveReady: () => void;
        const ready = new Promise<void>(r => { resolveReady = r; });

        const shell: PersistentShell = { process: proc, host: hostName, ready };
        this._persistentShells.set(hostName, shell);

        let buffer = '';
        let isReady = false;

        proc.stdout!.on('data', (data: Buffer) => {
            buffer += data.toString();

            // Check for ready marker during initial connect
            if (!isReady) {
                const readyIdx = buffer.indexOf(readyMarker);
                if (readyIdx === -1) { return; }
                isReady = true;
                buffer = buffer.slice(readyIdx + readyMarker.length);
                // Consume trailing newline
                if (buffer.startsWith('\n')) { buffer = buffer.slice(1); }
                resolveReady!();
            }

            // Process pending command response
            if (shell.pending) {
                const p = shell.pending;
                const exitMarker = `__CS_EXIT_${p.marker}:`;
                const endMarker = `__CS_END_${p.marker}__`;

                // Scan buffer for exit code marker and end marker
                while (buffer.length > 0) {
                    if (!p.gotExit) {
                        const exitIdx = buffer.indexOf(exitMarker);
                        if (exitIdx === -1) {
                            // Accumulate everything before any potential partial marker
                            const safeEnd = buffer.length - (exitMarker.length + 10);
                            if (safeEnd > 0) {
                                p.stdout += buffer.slice(0, safeEnd);
                                buffer = buffer.slice(safeEnd);
                            }
                            break;
                        }
                        p.stdout += buffer.slice(0, exitIdx);
                        const afterExit = buffer.slice(exitIdx + exitMarker.length);
                        const nlIdx = afterExit.indexOf('\n');
                        if (nlIdx === -1) { break; } // exit code line not complete yet
                        p.exitCode = parseInt(afterExit.slice(0, nlIdx), 10) || 0;
                        p.gotExit = true;
                        buffer = afterExit.slice(nlIdx + 1);
                    }

                    if (!p.gotEnd) {
                        const endIdx = buffer.indexOf(endMarker);
                        if (endIdx === -1) { break; }
                        p.gotEnd = true;
                        buffer = buffer.slice(endIdx + endMarker.length);
                        // Consume trailing newline if present
                        if (buffer.startsWith('\n')) { buffer = buffer.slice(1); }
                    }

                    if (p.gotExit && p.gotEnd) {
                        const result = { stdout: p.stdout, code: p.exitCode };
                        shell.pending = undefined;
                        p.resolve(result);
                        break;
                    }
                }
            }
        });

        // Handle askpass prompts (same as runRemoteCommand)
        let disposed = false;
        const handledPrompts = new Set<string>();
        const pollInterval = setInterval(async () => {
            if (disposed) { return; }
            try {
                const files = fs.readdirSync(sessionDir);
                for (const file of files) {
                    if (!file.startsWith('prompt-') || handledPrompts.has(file)) { continue; }
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
                        proc.kill();
                    }
                }
            } catch { /* ignore */ }
        }, 200);

        proc.on('close', () => {
            disposed = true;
            clearInterval(pollInterval);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this._persistentShells.delete(hostName);
            if (shell.pending) {
                shell.pending.reject(new Error('SSH connection closed'));
                shell.pending = undefined;
            }
        });

        proc.on('error', (err) => {
            disposed = true;
            clearInterval(pollInterval);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this._persistentShells.delete(hostName);
            if (shell.pending) {
                shell.pending.reject(err);
                shell.pending = undefined;
            }
        });

        // Send ready probe
        proc.stdin!.write(`echo '${readyMarker}'\n`);

        return shell;
    }

    /**
     * Run a command on a persistent SSH shell. Returns stdout and exit code.
     * Commands are serialized — only one runs at a time per host.
     */
    private async _runShellCommand(hostName: string, command: string): Promise<{ stdout: string; code: number }> {
        const shell = this._getOrCreateShell(hostName);
        await shell.ready;

        if (shell.process.killed) {
            throw new Error('SSH connection closed');
        }

        const marker = crypto.randomBytes(6).toString('hex');

        return new Promise((resolve, reject) => {
            shell.pending = {
                resolve, reject, marker,
                stdout: '', gotExit: false, exitCode: 0, gotEnd: false,
            };

            // Wrap the command: run it, then echo the exit code and end marker
            const wrapped = `${command}\necho "__CS_EXIT_${marker}:$?"\necho "__CS_END_${marker}__"\n`;
            shell.process.stdin!.write(wrapped);
        });
    }

    /**
     * Dispose all persistent SSH shells.
     */
    public disposePersistentShells() {
        for (const [, shell] of this._persistentShells) {
            shell.process.kill();
        }
        this._persistentShells.clear();
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

        webviewView.onDidDispose(() => {
            this.disposePersistentShells();
            this.stopAllLogStreams();
            this.stopAllLocalProcesses();
        });

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
                case 'cancelBrowse': {
                    // Increment request ID so in-flight results are discarded
                    this._browseRequestId.set(data.host, (this._browseRequestId.get(data.host) ?? 0) + 1);
                    // Kill the stuck persistent shell so the next browse gets a fresh connection
                    const stuckShell = this._persistentShells.get(data.host);
                    if (stuckShell) {
                        stuckShell.process.kill();
                        this._persistentShells.delete(data.host);
                    }
                    this.postMessage({ type: 'browseCancelled', host: data.host });
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
                    const removing = this._jobSessions.find(s => s.id === data.sessionId);
                    if (removing?.isLocal) {
                        this.stopLocalSession(data.sessionId);
                    }
                    this._jobSessions = this._jobSessions.filter(s => s.id !== data.sessionId);
                    this._saveSessions();
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
                case 'testLocal': {
                    this.testLocal();
                    break;
                }
                case 'stopLocal': {
                    this.stopLocalSession(data.sessionId);
                    break;
                }
                case 'connectLocal': {
                    this.connectLocalSession(data.sessionId);
                    break;
                }
                case 'viewLogs': {
                    this.viewSessionLogs(data.sessionId);
                    break;
                }
                case 'toggleSessionLogs': {
                    this.toggleSessionLogStream(data.sessionId);
                    break;
                }
                case 'stopSessionLogs': {
                    this.stopSessionLogStream(data.sessionId);
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
        this._saveSessions();
        this.postMessage({ type: 'scriptPreview', sessionId, host: hostName, script });
    }

    /**
     * Generate a SLURM batch script from job parameters.
     * The script embeds a workflow YAML and pipes it to linkspan via stdin heredoc.
     * Assumes linkspan is available in PATH.
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
            `#SBATCH --output=~/.cybershuttle/logs/linkspan-session-%j.out`,
            `#SBATCH --error=~/.cybershuttle/logs/linkspan-session-%j.err`,
        ];

        // Add GPU if selected
        if (gpu !== 'None') {
            // Map display name to SLURM gres tag (e.g. "NVIDIA A100" → "gpu:a100:1")
            const gpuTag = gpu.replace('NVIDIA ', '').toLowerCase();
            sbatchLines.push(`#SBATCH --gres=gpu:${gpuTag}:1`);
        }

        // Build the workflow YAML that will be passed to linkspan via stdin.
        // Use $SLURM_JOB_ID in the tunnel name so each job gets a unique tunnel.
        const workflowYaml = [
            `name: "cs-bridge-hpc-setup"`,
            ``,
            `steps:`,
            `  - action: "vscode.create_session"`,
            `    name: "Start SSH server"`,
            `    outputs:`,
            `      bind_port: "ssh_port"`,
            ``,
            `  - action: "tunnel.devtunnel_create"`,
            `    name: "Create devtunnel"`,
            `    params:`,
            `      tunnel_name: "ls-$SLURM_JOB_ID"`,
            `      expiration: "1d"`,
            `      ports:`,
            `        - "{{.ssh_port}}"`,
            `    outputs:`,
            `      tunnel_id: "tunnel_id"`,
            ``,
            `  - action: "tunnel.devtunnel_host"`,
            `    name: "Host devtunnel"`,
            `    params:`,
            `      tunnel_name: "ls-$SLURM_JOB_ID"`,
            `      create_token: true`,
            `    outputs:`,
            `      connection_url: "tunnel_url"`,
            `      token: "tunnel_token"`,
        ].join('\n');

        const script = [
            `#!/bin/bash`,
            ...sbatchLines,
            ``,
            `# --- Run linkspan with workflow from stdin ---`,
            `linkspan --workflow - <<'WORKFLOW_EOF'`,
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
        this._activeTab = 'sessions';
        this._saveSessions();
        this.refresh();

        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Submitting SLURM job on ${session.host} ---`);

        try {
            // Base64-encode the script to avoid quoting issues over SSH
            const scriptB64 = Buffer.from(session.script).toString('base64');
            const result = await this.runRemoteCommand(
                session.host,
                `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d | sbatch`
            );

            if (result.code === 0) {
                // sbatch typically outputs "Submitted batch job <id>"
                const match = result.stdout.match(/Submitted batch job (\d+)/);
                session.slurmJobId = match ? match[1] : undefined;
                session.status = 'Pending';
                session.errorMessage = undefined;
                this._outputChannel.appendLine(result.stdout);
                vscode.window.showInformationMessage(
                    `SLURM job submitted on ${session.host}${session.slurmJobId ? ` (Job ID: ${session.slurmJobId})` : ''}`
                );
            } else {
                session.status = 'Failed';
                // Extract concise error from sbatch stderr (strip "sbatch: error: " prefixes)
                const errLines = (result.stderr || '').split('\n')
                    .map(l => l.replace(/^sbatch:\s*error:\s*/i, '').trim())
                    .filter(l => l.length > 0);
                session.errorMessage = errLines.join(' ') || `exit code ${result.code}`;
                this._outputChannel.appendLine(`sbatch exited with code ${result.code}`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
                vscode.window.showErrorMessage(`Failed to submit job on ${session.host}: ${session.errorMessage}`);
            }
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = err.message;
            this._outputChannel.appendLine(`Error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to submit job: ${err.message}`);
        }

        this._saveSessions();
        this.refresh();
    }

    /**
     * Relaunch a failed session by resubmitting its script.
     */
    private async viewSessionLogs(sessionId: string) {
        const session = this._jobSessions.find(s => s.id === sessionId);
        if (!session || !session.slurmJobId) {
            vscode.window.showErrorMessage('Session not found or no SLURM job ID available.');
            return;
        }

        const jobId = session.slurmJobId;
        const logBase = `~/.cybershuttle/logs/linkspan-session-${jobId}`;

        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Fetching logs for Job ${jobId} on ${session.host} ---`);

        try {
            const cmd = [
                `echo '=== STDOUT ==='`,
                `if [ -f ${logBase}.out ]; then tail -c 65536 ${logBase}.out; else echo '[No stdout log found]'; fi`,
                `echo ''`,
                `echo '=== STDERR ==='`,
                `if [ -f ${logBase}.err ]; then tail -c 65536 ${logBase}.err; else echo '[No stderr log found]'; fi`,
            ].join(' && ');

            const result = await this.runRemoteCommand(session.host, cmd);

            if (result.code === 0) {
                this._outputChannel.appendLine(result.stdout);
            } else {
                this._outputChannel.appendLine(`Failed to fetch logs (exit code ${result.code})`);
                if (result.stderr) {
                    this._outputChannel.appendLine(result.stderr);
                }
            }
        } catch (err: any) {
            this._outputChannel.appendLine(`Error fetching logs: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to fetch logs: ${err.message}`);
        }
    }

    /**
     * Toggle real-time log streaming for a session.
     * Spawns a tail -f SSH process that streams stdout/stderr to the webview.
     */
    private toggleSessionLogStream(sessionId: string) {
        // If already tailing, stop it
        if (this._logTailProcesses.has(sessionId)) {
            this.stopSessionLogStream(sessionId);
            return;
        }

        const session = this._jobSessions.find(s => s.id === sessionId);
        if (!session || !session.slurmJobId) {
            return;
        }

        const jobId = session.slurmJobId;
        const logBase = `~/.cybershuttle/logs/linkspan-session-${jobId}`;
        const askpassScript = path.join(this._extensionUri.fsPath, 'scripts', 'askpass.js');
        const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-askpass-'));

        // For failed/completed jobs, just cat the logs. For active/pending, tail -f for real-time streaming.
        const isFailed = session.status === 'Failed' || session.status === 'Completed';
        const tailCmd = isFailed
            ? `echo '=== stdout ==='; if [ -f ${logBase}.out ]; then cat ${logBase}.out; else echo '[No log file]'; fi; echo ''; echo '=== stderr ==='; if [ -f ${logBase}.err ]; then cat ${logBase}.err; else echo '[No log file]'; fi`
            : `if [ -f ${logBase}.out ]; then echo '[stdout]'; cat ${logBase}.out; fi; if [ -f ${logBase}.err ]; then echo '[stderr]'; cat ${logBase}.err; fi; tail -n 0 -f ${logBase}.out ${logBase}.err 2>/dev/null`;

        const proc = spawn('ssh', [
            ...this.getControlMasterArgs(session.host),
            '-o', 'NumberOfPasswordPrompts=3',
            session.host,
            tailCmd,
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

        this._logTailProcesses.set(sessionId, proc);

        // Tell webview the stream is open
        this.postMessage({ type: 'sessionLogStarted', sessionId });

        proc.stdout!.on('data', (data: Buffer) => {
            this.postMessage({
                type: 'sessionLogData',
                sessionId,
                text: data.toString(),
            });
        });

        proc.stderr!.on('data', (data: Buffer) => {
            // SSH stderr (not the remote stderr which comes via stdout from tail)
            const text = data.toString();
            if (!text.includes('password') && !text.includes('Permission')) {
                this.postMessage({
                    type: 'sessionLogData',
                    sessionId,
                    text: text,
                });
            }
        });

        proc.on('close', () => {
            this._logTailProcesses.delete(sessionId);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this.postMessage({ type: 'sessionLogStopped', sessionId });
        });

        proc.on('error', () => {
            this._logTailProcesses.delete(sessionId);
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            this.postMessage({ type: 'sessionLogStopped', sessionId });
        });
    }

    private stopSessionLogStream(sessionId: string) {
        const proc = this._logTailProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this._logTailProcesses.delete(sessionId);
        }
        this.postMessage({ type: 'sessionLogStopped', sessionId });
    }

    private stopAllLogStreams() {
        for (const [id, proc] of this._logTailProcesses) {
            proc.kill();
        }
        this._logTailProcesses.clear();
    }

    private stopAllLocalProcesses() {
        for (const [, proc] of this._localProcesses) {
            proc.kill();
        }
        this._localProcesses.clear();
    }

    private async relaunchSession(sessionId: string) {
        const session = this._jobSessions.find(s => s.id === sessionId);
        if (!session || !session.script) {
            vscode.window.showErrorMessage('Session not found or script missing.');
            return;
        }
        session.slurmJobId = undefined;
        session.errorMessage = undefined;
        await this.submitJob(sessionId);
    }

    /**
     * Cancel a pending job preview (remove the session that was created during preview).
     */
    private cancelJobPreview(sessionId: string) {
        this._jobSessions = this._jobSessions.filter(s => s.id !== sessionId);
        this._saveSessions();
        this.postMessage({ type: 'scriptPreviewDismissed' });
    }

    /**
     * Run linkspan locally for testing the workflow without SSH/SLURM.
     * Spawns linkspan as a child process with the workflow YAML via stdin.
     */
    private async testLocal() {
        const sessionId = crypto.randomBytes(4).toString('hex');

        const tunnelName = `ls-${sessionId}`;
        const workflowYaml = [
            `name: "cs-bridge-hpc-setup"`,
            ``,
            `steps:`,
            `  - action: "vscode.create_session"`,
            `    name: "Start SSH server"`,
            `    outputs:`,
            `      bind_port: "ssh_port"`,
            ``,
            `  - action: "tunnel.devtunnel_create"`,
            `    name: "Create devtunnel"`,
            `    params:`,
            `      tunnel_name: "${tunnelName}"`,
            `      expiration: "1d"`,
            `      ports:`,
            `        - "{{.ssh_port}}"`,
            `    outputs:`,
            `      tunnel_id: "tunnel_id"`,
            ``,
            `  - action: "tunnel.devtunnel_host"`,
            `    name: "Host devtunnel"`,
            `    params:`,
            `      tunnel_name: "${tunnelName}"`,
            `      create_token: true`,
            `    outputs:`,
            `      connection_url: "tunnel_url"`,
            `      token: "tunnel_token"`,
        ].join('\n');

        const session: JobSession = {
            id: sessionId,
            host: 'local',
            cpus: '-',
            memory: '-',
            gpu: 'None',
            wallTime: '-',
            queue: '-',
            allocation: '-',
            status: 'Submitting',
            submittedAt: new Date(),
            script: workflowYaml,
            isLocal: true,
        };

        this._jobSessions.push(session);
        this._activeTab = 'sessions';
        this._saveSessions();
        this.refresh();

        this._outputChannel.show(true);
        this._outputChannel.appendLine(`\n--- Starting local linkspan session ---`);

        try {
            const proc = spawn('linkspan', ['--port', '0', '--workflow', '-'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            });

            this._localProcesses.set(sessionId, proc);
            session.localPid = proc.pid;
            session.status = 'Active';
            this._saveSessions();
            this.refresh();

            proc.stdin!.write(workflowYaml);
            proc.stdin!.end();

            // Parse linkspan workflow output for captured variables and errors.
            // The workflow engine logs:
            //   "workflow: captured <var> = <value>"  — variable captures
            //   "workflow: workflow step N (...): Error: ..."  — step failures
            const parseOutput = (text: string) => {
                for (const line of text.split('\n')) {
                    // Capture workflow variables
                    const cap = line.match(/workflow: captured (\S+) = (.+)/);
                    if (cap) {
                        const [, varName, value] = cap;
                        if (varName === 'ssh_port') {
                            session.sshPort = parseInt(value, 10);
                        } else if (varName === 'tunnel_url') {
                            session.tunnelUrl = value.trim();
                        } else if (varName === 'tunnel_token') {
                            session.tunnelToken = value.trim();
                        } else if (varName === 'tunnel_id') {
                            session.tunnelId = value.trim();
                        }
                        this._saveSessions();
                        this.refresh();
                        continue;
                    }

                    // Detect workflow step errors
                    const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): Error: (.+)/);
                    if (errMatch) {
                        const [, stepName, errMsg] = errMatch;
                        session.status = 'Failed';
                        session.errorMessage = `${stepName}: ${errMsg.trim()}`;
                        this._saveSessions();
                        this.refresh();
                        vscode.window.showErrorMessage(`Linkspan workflow failed — ${stepName}: ${errMsg.trim()}`);
                        continue;
                    }

                    // Detect fatal errors (e.g. "failed to listen", panic, etc.)
                    const fatal = line.match(/(?:fatal|FATAL|panic): (.+)/);
                    if (fatal) {
                        session.status = 'Failed';
                        session.errorMessage = fatal[1].trim();
                        this._saveSessions();
                        this.refresh();
                        vscode.window.showErrorMessage(`Linkspan error: ${fatal[1].trim()}`);
                    }
                }
            };

            proc.stdout!.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.appendLine(text.trimEnd());
                parseOutput(text);
            });

            proc.stderr!.on('data', (data: Buffer) => {
                const text = data.toString();
                this._outputChannel.appendLine(text.trimEnd());
                parseOutput(text);
            });

            proc.on('close', (code) => {
                this._localProcesses.delete(sessionId);
                const s = this._jobSessions.find(s => s.id === sessionId);
                if (s) {
                    // Only update status if not already marked as Failed by error parsing
                    if (s.status !== 'Failed') {
                        s.status = code === 0 ? 'Completed' : 'Failed';
                        if (code !== 0 && code !== null) {
                            s.errorMessage = `linkspan exited with code ${code}`;
                            vscode.window.showErrorMessage(`Linkspan exited with code ${code}. Check output for details.`);
                        }
                    }
                    s.localPid = undefined;
                    this._saveSessions();
                    this.refresh();
                }
                this._outputChannel.appendLine(`\n--- Local linkspan session ended (exit code ${code}) ---`);
            });

            proc.on('error', (err) => {
                this._localProcesses.delete(sessionId);
                const s = this._jobSessions.find(s => s.id === sessionId);
                if (s) {
                    s.status = 'Failed';
                    s.errorMessage = err.message;
                    s.localPid = undefined;
                    this._saveSessions();
                    this.refresh();
                }
                this._outputChannel.appendLine(`Error: ${err.message}`);
                vscode.window.showErrorMessage(`Local linkspan failed: ${err.message}`);
            });

            vscode.window.showInformationMessage('Local linkspan session started');
        } catch (err: any) {
            session.status = 'Failed';
            session.errorMessage = err.message;
            this._saveSessions();
            this.refresh();
            vscode.window.showErrorMessage(`Failed to start linkspan: ${err.message}`);
        }
    }

    /**
     * Connect to a local linkspan session's SSH server.
     * For local tests, connects directly to localhost:<sshPort> since devtunnel
     * port forwarding would loop back to itself on the same machine.
     * The full devtunnel workflow is still validated (tunnel created + hosted),
     * but the VS Code connection uses the direct SSH path.
     */
    private async connectLocalSession(sessionId: string) {
        const session = this._jobSessions.find(s => s.id === sessionId);
        if (!session) {
            vscode.window.showErrorMessage('Session not found.');
            return;
        }

        if (!session.sshPort) {
            vscode.window.showErrorMessage('SSH server not ready yet — waiting for linkspan to finish setup.');
            return;
        }

        // Write an SSH config entry (remove any existing entry first)
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        const hostAlias = `cs-tunnel-${sessionId}`;
        try {
            const existing = fs.readFileSync(sshConfigPath, 'utf-8');
            const re = new RegExp(`\\n# CS-Bridge auto-generated for session ${sessionId}\\nHost ${hostAlias}\\n(?:    [^\\n]+\\n)*`, 'g');
            fs.writeFileSync(sshConfigPath, existing.replace(re, ''));
        } catch { /* ignore if file doesn't exist yet */ }

        const configBlock = [
            ``,
            `# CS-Bridge auto-generated for session ${sessionId}`,
            `Host ${hostAlias}`,
            `    HostName 127.0.0.1`,
            `    Port ${session.sshPort}`,
            `    User user`,
            `    StrictHostKeyChecking no`,
            `    UserKnownHostsFile /dev/null`,
        ].join('\n');

        try {
            fs.appendFileSync(sshConfigPath, configBlock + '\n');
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update SSH config: ${err.message}`);
            return;
        }

        // Prompt for remote folder path
        const remotePath = await vscode.window.showInputBox({
            title: `Connect to linkspan session (localhost:${session.sshPort})`,
            prompt: 'Enter the remote folder path',
            placeHolder: '/home/user',
            value: os.homedir(),
        });

        if (remotePath) {
            vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.from({
                    scheme: 'vscode-remote',
                    authority: `ssh-remote+${hostAlias}`,
                    path: remotePath,
                }),
                true
            );
        }
    }

    /**
     * Stop a locally running linkspan session and clean up SSH config entry.
     */
    private stopLocalSession(sessionId: string) {
        // Kill linkspan process
        const proc = this._localProcesses.get(sessionId);
        if (proc) {
            proc.kill();
            this._localProcesses.delete(sessionId);
        }

        // Clean up the devtunnel (safety net — linkspan shutdown should do this too)
        const tunnelName = `ls-${sessionId}`;
        spawn('devtunnel', ['delete', tunnelName, '-f'], { stdio: 'ignore', detached: true }).unref();

        // Remove auto-generated SSH config entry
        const hostAlias = `cs-tunnel-${sessionId}`;
        const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
        try {
            const content = fs.readFileSync(sshConfigPath, 'utf-8');
            const re = new RegExp(`\\n# CS-Bridge auto-generated for session ${sessionId}\\nHost ${hostAlias}\\n(?:    [^\\n]+\\n)*`, 'g');
            const cleaned = content.replace(re, '');
            if (cleaned !== content) {
                fs.writeFileSync(sshConfigPath, cleaned);
            }
        } catch { /* ignore cleanup errors */ }

        const session = this._jobSessions.find(s => s.id === sessionId);
        if (session) {
            session.status = 'Completed';
            session.localPid = undefined;
            this._saveSessions();
            this.refresh();
        }
    }

    /**
     * Refresh session statuses by querying squeue on the remote host.
     * RUNNING → Active, PENDING → Pending, no output → completed/removed.
     */
    private async refreshSessions() {
        // Only check sessions that are still in a non-terminal state
        const sessionsToCheck = this._jobSessions.filter(
            s => s.slurmJobId && s.status !== 'Failed' && s.status !== 'Completed'
        );
        if (sessionsToCheck.length === 0) {
            this.refresh();
            return;
        }

        for (const session of sessionsToCheck) {
            try {
                const result = await this.runRemoteCommand(
                    session.host,
                    `squeue -j ${session.slurmJobId} -h -o "%T"`
                );

                const state = result.stdout.trim();
                if (result.code === 0 && state) {
                    if (state === 'RUNNING') {
                        session.status = 'Active';
                        session.errorMessage = undefined;
                    } else if (state === 'PENDING' || state === 'CONFIGURING') {
                        session.status = 'Pending';
                        session.errorMessage = undefined;
                    } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT' || state === 'NODE_FAIL' || state === 'OUT_OF_MEMORY') {
                        session.status = 'Failed';
                        session.errorMessage = `Job ${state}`;
                    }
                } else {
                    // Job no longer in squeue — use sacct to determine final state
                    try {
                        const sacctResult = await this.runRemoteCommand(
                            session.host,
                            `sacct -j ${session.slurmJobId} -n -o State%20,ExitCode,Reason%40 --parsable2 2>/dev/null | head -1`
                        );
                        const parts = sacctResult.stdout.trim().split('|');
                        const sacctState = (parts[0] || '').trim();

                        if (sacctState === 'COMPLETED') {
                            session.status = 'Completed';
                            session.errorMessage = undefined;
                        } else if (sacctState) {
                            session.status = 'Failed';
                            const reason = parts[2] && parts[2] !== 'None' ? `${sacctState} — ${parts[2]}` : sacctState;
                            session.errorMessage = reason;
                        } else {
                            session.status = 'Failed';
                            session.errorMessage = 'Job no longer in queue';
                        }
                    } catch {
                        session.status = 'Failed';
                        session.errorMessage = 'Job no longer in queue';
                    }
                }
            } catch {
                // SSH error — leave session in its current state
            }
        }

        this._saveSessions();
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
                this.postMessage({ type: 'associationsError', host: hostName, error: result.stderr || `exit code ${result.code}` });
            }
            this._outputChannel.appendLine(`--- End of partition info ---\n`);
        } catch (err: any) {
            this._outputChannel.appendLine(`Error: ${err.message}`);
            this.postMessage({ type: 'associationsError', host: hostName, error: err.message });
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
        const reqId = (this._browseRequestId.get(hostName) ?? 0) + 1;
        this._browseRequestId.set(hostName, reqId);

        this.postMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: true, entries: [] });

        try {
            // Use persistent shell for fast sequential browsing
            const result = await this._runShellCommand(
                hostName,
                `cd ${remotePath} && pwd && ls -lAhp`
            );

            // Discard if a newer request (or cancel) has superseded this one
            if (this._browseRequestId.get(hostName) !== reqId) { return; }

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
                this.postMessage({ type: 'fileListing', host: hostName, path: remotePath, loading: false, entries: [], error: `exit code ${result.code}` });
            }
        } catch (err: any) {
            if (this._browseRequestId.get(hostName) !== reqId) { return; }
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

        const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
        const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf'));

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
                        <span class="chevron">&#x203A;</span>
                    </div>
                    <div class="job-form" id="job-form-${escapeHtml(host.name)}" style="display:none;">
                        <div class="job-form-loading"><div class="spinner"></div>Fetching partitions...</div>
                        <div class="job-form-error" style="display:none;"><span class="job-form-error-text"></span><button class="job-form-retry-btn" data-host="${escapeHtml(host.name)}">Retry</button></div>
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
                const now = new Date();
                const sub = session.submittedAt;
                const diffMs = now.getTime() - sub.getTime();
                const diffMin = Math.floor(diffMs / 60000);
                const diffHr = Math.floor(diffMin / 60);
                const diffDay = Math.floor(diffHr / 24);
                const timeAgo = diffDay > 0 ? `${diffDay}d ago` : diffHr > 0 ? `${diffHr}h ago` : diffMin > 0 ? `${diffMin}m ago` : 'just now';
                const statusIcon = session.status === 'Active' ? '🟢' : session.status === 'Failed' ? '🔴' : session.status === 'Completed' ? '⚪' : session.status === 'Submitting' ? '🔵' : '🟡';
                const hasLogs = !!session.slurmJobId;
                const isLocal = !!session.isLocal;

                // Action buttons differ for local vs remote sessions
                let actionButtons: string;
                if (isLocal) {
                    if (session.status === 'Active') {
                        const canConnect = !!session.sshPort;
                        actionButtons = `${canConnect ? `<button class="connect-local-btn" data-session-id="${escapeHtml(session.id)}" title="Connect to SSH session"><i class="codicon codicon-play"></i></button>` : ''}<button class="stop-local-btn" data-session-id="${escapeHtml(session.id)}" title="Stop"><i class="codicon codicon-debug-stop"></i></button>`;
                    } else {
                        actionButtons = `<button class="relaunch-local-btn" data-session-id="${escapeHtml(session.id)}" title="Relaunch"><i class="codicon codicon-refresh"></i></button>`;
                    }
                } else if (session.status === 'Failed' || session.status === 'Completed') {
                    actionButtons = `<button class="relaunch-session-btn" data-session-id="${escapeHtml(session.id)}" title="Relaunch"><i class="codicon codicon-refresh"></i></button>`;
                } else {
                    actionButtons = `<button class="connect-session-btn" data-session-id="${escapeHtml(session.id)}" data-host="${escapeHtml(session.host)}"${session.status !== 'Active' ? ' disabled' : ''} title="Connect"><i class="codicon codicon-play"></i></button>`;
                }

                // Detail lines differ for local vs remote
                let detailHtml: string;
                if (isLocal) {
                    const tunnelInfo = session.tunnelUrl
                        ? `<span class="session-detail"><i class="codicon codicon-globe"></i> ${escapeHtml(session.tunnelUrl)}</span>`
                        : (session.status === 'Active' ? `<span class="session-detail"><i class="codicon codicon-loading codicon-modifier-spin"></i> setting up tunnel...</span>` : '');
                    detailHtml = `<span class="session-detail"><i class="codicon codicon-terminal"></i> local linkspan${session.localPid ? ` (pid ${session.localPid})` : ''}${session.sshPort ? ` <i class="codicon codicon-plug"></i> ssh :${session.sshPort}` : ''}</span>${tunnelInfo}`;
                } else {
                    const wtParts = session.wallTime.split(':').map(Number);
                    const wtTotalMin = (wtParts[0] || 0) * 60 + (wtParts[1] || 0);
                    const wallTimeShort = wtTotalMin >= 1440 ? `${Math.floor(wtTotalMin / 1440)}d` : wtTotalMin >= 60 ? `${Math.floor(wtTotalMin / 60)}hr` : `${wtTotalMin}min`;
                    detailHtml = `<span class="session-detail"><i class="codicon codicon-server-process"></i>${escapeHtml(session.cpus)} <i class="codicon codicon-circuit-board"></i>${escapeHtml(session.memory)} ${session.gpu !== 'None' ? `<i class="codicon codicon-dashboard"></i>${escapeHtml(session.gpu)} ` : ''}<i class="codicon codicon-clock"></i>${wallTimeShort}</span>
                            <span class="session-detail"><i class="codicon codicon-layers"></i>${escapeHtml(session.queue)} <i class="codicon codicon-key"></i>${escapeHtml(session.allocation)}</span>`;
                }

                return `
                <div class="session-entry">
                    <div class="session-row${hasLogs ? ' session-row-clickable' : ''}" data-session-id="${escapeHtml(session.id)}">
                        <div class="session-info">
                            <div class="session-header">
                                <span class="session-name">${statusIcon} ${escapeHtml(session.host)}${session.slurmJobId ? ` <span class="session-job-id">#${escapeHtml(session.slurmJobId)}</span>` : ''}</span>
                                <div class="session-header-right">
                                    <span class="session-time-ago">${timeAgo}</span>
                                    ${actionButtons}
                                    <button class="remove-session-btn" data-session-id="${escapeHtml(session.id)}" title="Remove">✕</button>
                                </div>
                            </div>
                            ${detailHtml}
                            ${session.status === 'Failed' && session.errorMessage ? `<span class="session-error">${escapeHtml(session.errorMessage)}</span>` : ''}
                        </div>
                    </div>
                    ${hasLogs ? `<div class="session-log-panel" id="session-log-${escapeHtml(session.id)}" style="display:none;"><pre class="session-log-content"></pre></div>` : ''}
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
                        <span class="chevron">&#x203A;</span>
                    </div>
                    <div class="file-browser" id="file-browser-${escapeHtml(host.name)}" style="display:none;">
                        <div class="file-nav-bar">
                            <div class="file-breadcrumbs" id="file-breadcrumbs-${escapeHtml(host.name)}"></div>
                            <button class="file-nav-btn file-back-btn" data-host="${escapeHtml(host.name)}" title="Back" disabled>&#x2039;</button>
                            <button class="file-nav-btn file-forward-btn" data-host="${escapeHtml(host.name)}" title="Forward" disabled>&#x203A;</button>
                        </div>
                        <div class="file-status" id="file-status-${escapeHtml(host.name)}"></div>
                        <div class="file-list" id="file-list-${escapeHtml(host.name)}"></div>
                    </div>
                </div>
            `).join('')
            : '<p class="empty-message">No SSH hosts found in ~/.ssh/config</p>';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${codiconsCssUri}">
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
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.15s ease;
            flex-shrink: 0;
            transform: rotate(90deg);
        }
        .ssh-host-row.expanded .chevron {
            transform: rotate(270deg);
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
        .job-form-error {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 0;
            font-size: 12px;
            color: var(--vscode-errorForeground);
        }
        .job-form-retry-btn {
            margin: 0;
            padding: 2px 8px;
            font-size: 11px;
            flex-shrink: 0;
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
        .skeleton {
            display: inline-block;
            background: linear-gradient(90deg,
                var(--vscode-editor-inactiveSelectionBackground) 25%,
                var(--vscode-list-hoverBackground) 50%,
                var(--vscode-editor-inactiveSelectionBackground) 75%
            );
            background-size: 200% 100%;
            animation: shimmer 1.5s ease-in-out infinite;
            border-radius: 3px;
        }
        .skeleton-text {
            height: 12px;
            vertical-align: middle;
        }
        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
        .job-form-fields {
            display: none;
        }
        .file-browser {
            border-top: 1px solid var(--vscode-panel-border);
        }
        .file-nav-bar {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .file-nav-btn {
            padding: 0 4px;
            font-size: 14px;
            line-height: 18px;
            flex-shrink: 0;
            background: none;
            color: var(--vscode-descriptionForeground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        .file-nav-btn:hover:not(:disabled) {
            color: var(--vscode-foreground);
            background: var(--vscode-list-hoverBackground);
        }
        .file-nav-btn:disabled {
            opacity: 0.4;
            cursor: default;
        }
        .file-stop-btn {
            padding: 2px 6px;
            font-size: 10px;
            flex-shrink: 0;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-errorForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }
        .file-stop-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .file-breadcrumbs {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 2px;
            font-size: 11px;
            flex: 1;
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
        }
        .breadcrumb-seg {
            cursor: pointer;
            color: var(--vscode-textLink-foreground);
            padding: 1px 2px;
            border-radius: 2px;
        }
        .breadcrumb-root {
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
        .file-status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 0;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .file-status.error {
            color: var(--vscode-errorForeground);
        }
        .file-status:empty {
            display: none;
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
        }
        .session-info {
            display: flex;
            flex-direction: column;
            overflow: hidden;
            flex: 1;
            min-width: 0;
        }
        .session-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .session-name {
            font-weight: 600;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .session-job-id {
            font-weight: 400;
            color: var(--vscode-descriptionForeground);
        }
        .session-header-right {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }
        .session-time-ago {
            font-size: 10px;
            font-weight: 400;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .session-detail {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .session-detail .codicon {
            font-size: 10px;
            margin-right: 2px;
            margin-left: 4px;
        }
        .session-detail .codicon:first-child {
            margin-left: 0;
        }
        .session-row-clickable {
            cursor: pointer;
        }
        .session-row-clickable:hover .session-name {
            text-decoration: underline;
        }
        .session-error {
            font-size: 10px;
            color: var(--vscode-errorForeground);
            white-space: normal;
            margin-top: 2px;
        }
        .session-log-panel {
            margin-top: 6px;
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            max-height: 200px;
            overflow: auto;
        }
        .session-log-content {
            margin: 0;
            padding: 8px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 10px;
            line-height: 1.3;
            white-space: pre-wrap;
            word-break: break-all;
            color: var(--vscode-editor-foreground);
        }
        .connect-session-btn {
            margin: 0;
            padding: 4px 6px;
            font-size: 14px;
            flex-shrink: 0;
            background: none;
            color: var(--vscode-foreground);
            border: none;
            cursor: pointer;
            border-radius: 3px;
        }
        .connect-session-btn:hover:not(:disabled) {
            background: var(--vscode-list-hoverBackground);
        }
        .connect-session-btn:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .relaunch-session-btn {
            margin: 0;
            padding: 4px 6px;
            font-size: 14px;
            flex-shrink: 0;
            background: none;
            color: var(--vscode-foreground);
            border: none;
            cursor: pointer;
            border-radius: 3px;
        }
        .relaunch-session-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .remove-session-btn {
            margin: 0;
            padding: 4px 6px;
            font-size: 12px;
            flex-shrink: 0;
            background: none;
            color: var(--vscode-descriptionForeground);
            border: none;
            cursor: pointer;
            border-radius: 3px;
        }
        .remove-session-btn:hover {
            background: var(--vscode-list-hoverBackground);
            color: var(--vscode-errorForeground);
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
            font-size: 9px;
            line-height: 1.3;
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
        <button id="test-local-btn" class="full-width" style="margin-bottom:8px;">Test Local (linkspan)</button>
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

        document.getElementById('test-local-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'testLocal' });
        });

        document.getElementById('refresh-sessions-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refreshSessions' });
        });

        // File browser history per host: { back: string[], forward: string[], current: string|null, loading: bool }
        const fileHistory = {};
        function getHistory(host) {
            if (!fileHistory[host]) { fileHistory[host] = { back: [], forward: [], current: null, loading: false }; }
            return fileHistory[host];
        }
        function updateNavButtons(host) {
            const h = getHistory(host);
            const backBtn = document.querySelector('.file-back-btn[data-host="' + host + '"]');
            const fwdBtn = document.querySelector('.file-forward-btn[data-host="' + host + '"]');
            if (backBtn) { backBtn.disabled = h.back.length === 0; }
            if (fwdBtn) { fwdBtn.disabled = h.forward.length === 0; }
        }
        function navigateTo(host, path, addToHistory) {
            const h = getHistory(host);
            if (addToHistory && h.current) {
                h.back.push(h.current);
                h.forward = [];
            }
            h.current = path;
            h.loading = true;
            updateNavButtons(host);
            vscode.postMessage({ type: 'browseDir', host: host, path: path });
        }

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
                        navigateTo(host, '~', false);
                    }
                }
            });
        });

        // Back/forward buttons
        document.querySelectorAll('.file-back-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                const h = getHistory(host);
                if (h.back.length > 0) {
                    h.forward.push(h.current);
                    h.current = h.back.pop();
                    h.loading = true;
                    updateNavButtons(host);
                    vscode.postMessage({ type: 'browseDir', host: host, path: h.current });
                }
            });
        });

        document.querySelectorAll('.file-forward-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                const h = getHistory(host);
                if (h.forward.length > 0) {
                    h.back.push(h.current);
                    h.current = h.forward.pop();
                    h.loading = true;
                    updateNavButtons(host);
                    vscode.postMessage({ type: 'browseDir', host: host, path: h.current });
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
                        form.querySelector('.job-form-error').style.display = 'none';
                        vscode.postMessage({ type: 'queryAssociations', host: host });
                    }
                }
            });
        });

        // Add click handlers to retry buttons
        document.querySelectorAll('.job-form-retry-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const host = btn.getAttribute('data-host');
                const form = document.getElementById('job-form-' + host);
                if (form) {
                    form.querySelector('.job-form-loading').style.display = 'flex';
                    form.querySelector('.job-form-error').style.display = 'none';
                    vscode.postMessage({ type: 'queryAssociations', host: host });
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

        // Add click handlers to local session connect buttons
        document.querySelectorAll('.connect-local-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sessionId = btn.getAttribute('data-session-id');
                vscode.postMessage({ type: 'connectLocal', sessionId: sessionId });
            });
        });

        // Add click handlers to local session stop buttons
        document.querySelectorAll('.stop-local-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sessionId = btn.getAttribute('data-session-id');
                vscode.postMessage({ type: 'stopLocal', sessionId: sessionId });
            });
        });

        // Add click handlers to local session relaunch buttons
        document.querySelectorAll('.relaunch-local-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sessionId = btn.getAttribute('data-session-id');
                vscode.postMessage({ type: 'removeSession', sessionId: sessionId });
                vscode.postMessage({ type: 'testLocal' });
            });
        });

        // Add click handlers to session rows (toggle log panel)
        document.querySelectorAll('.session-row-clickable').forEach(row => {
            row.addEventListener('click', (e) => {
                // Don't toggle logs if a button was clicked
                if (e.target.closest('.session-header-right')) { return; }
                const sessionId = row.getAttribute('data-session-id');
                const logPanel = document.getElementById('session-log-' + sessionId);
                if (!logPanel) { return; }
                const isOpening = logPanel.style.display === 'none';
                if (isOpening) {
                    logPanel.style.display = 'block';
                    vscode.postMessage({ type: 'toggleSessionLogs', sessionId: sessionId });
                } else {
                    logPanel.style.display = 'none';
                    vscode.postMessage({ type: 'stopSessionLogs', sessionId: sessionId });
                }
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

            if (msg.type === 'sessionLogData') {
                const logPanel = document.getElementById('session-log-' + msg.sessionId);
                if (logPanel) {
                    const content = logPanel.querySelector('.session-log-content');
                    if (content) {
                        content.textContent += msg.text;
                        logPanel.scrollTop = logPanel.scrollHeight;
                    }
                }
                return;
            }

            if (msg.type === 'sessionLogStopped') {
                const logPanel = document.getElementById('session-log-' + msg.sessionId);
                if (logPanel) {
                    const content = logPanel.querySelector('.session-log-content');
                    if (content && !content.textContent) {
                        content.textContent = '[No logs available yet]';
                    }
                }
                return;
            }

            if (msg.type === 'associationsError') {
                const form = document.getElementById('job-form-' + msg.host);
                if (!form) { return; }
                form.querySelector('.job-form-loading').style.display = 'none';
                form.querySelector('.job-form-error').style.display = 'flex';
                form.querySelector('.job-form-error-text').textContent = 'Failed to fetch partitions: ' + msg.error;
                return;
            }

            if (msg.type === 'associations') {
                const host = msg.host;
                const partitions = msg.partitions; // { name: { accounts, nodes, maxCpus, maxGpus } }
                const form = document.getElementById('job-form-' + host);
                if (!form) { return; }

                form.querySelector('.job-form-loading').style.display = 'none';
                form.querySelector('.job-form-error').style.display = 'none';
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

            if (msg.type === 'browseCancelled') {
                const host = msg.host;
                const h = getHistory(host);
                h.loading = false;
                const statusEl = document.getElementById('file-status-' + host);
                const listEl = document.getElementById('file-list-' + host);
                if (statusEl) { statusEl.className = 'file-status error'; statusEl.innerHTML = 'Cancelled'; }
                if (listEl) { listEl.innerHTML = ''; }
                return;
            }

            if (msg.type === 'fileListing') {
                const host = msg.host;
                const breadcrumbsEl = document.getElementById('file-breadcrumbs-' + host);
                const statusEl = document.getElementById('file-status-' + host);
                const listEl = document.getElementById('file-list-' + host);
                if (!breadcrumbsEl || !statusEl || !listEl) { return; }
                const h = getHistory(host);

                if (msg.loading) {
                    if (!breadcrumbsEl.innerHTML || breadcrumbsEl.querySelector('.skeleton')) {
                        breadcrumbsEl.innerHTML = '<span class="skeleton skeleton-text" style="width:120px"></span>';
                    }
                    statusEl.className = 'file-status';
                    statusEl.innerHTML = '<div class="spinner"></div>Loading...<button class="file-stop-btn" data-host="' + host + '">Stop</button>';
                    listEl.innerHTML = '';
                    // Attach stop button handler
                    const stopBtn = statusEl.querySelector('.file-stop-btn');
                    if (stopBtn) {
                        stopBtn.addEventListener('click', () => {
                            vscode.postMessage({ type: 'cancelBrowse', host: host });
                        });
                    }
                    return;
                }

                h.loading = false;
                statusEl.className = 'file-status';
                statusEl.innerHTML = '';

                if (msg.error) {
                    statusEl.className = 'file-status error';
                    statusEl.innerHTML = 'Error: ' + msg.error;
                    listEl.innerHTML = '';
                    return;
                }

                // Update current path in history to resolved path
                const pathStr = msg.path;
                h.current = pathStr;

                // Build breadcrumbs with server icon for root
                const segments = pathStr.split('/').filter(s => s.length > 0);
                let bc = '<span class="breadcrumb-seg breadcrumb-root" data-path="/" data-host="' + host + '" title="/">~</span>';
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
                        navigateTo(host, seg.getAttribute('data-path'), true);
                    });
                });

                updateNavButtons(host);

                // Build file list
                if (msg.entries.length === 0) {
                    statusEl.innerHTML = 'Empty directory';
                    listEl.innerHTML = '';
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
                        navigateTo(host, entry.getAttribute('data-path'), true);
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

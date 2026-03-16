import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { TunnelCredentials } from './TunnelManager.js';
import { findRuntime, Runtime } from './WorkspaceManager.js';
import { CSExtensionContext } from './ExtensionContext.js';
import { saveSessions } from './SessionManager.js';
import * as vscode from 'vscode';



/**
* Apply a workflow variable capture to a session.
* Returns true if the variable was recognized and applied.
*/
function _applyWorkflowCapture(session: Runtime, varName: string, value: string): boolean {
    if (varName === 'ssh_port') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n > 0) { session.sshPort = n; }
    } else if (varName === 'log_port') {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n > 0) { session.logPort = n; }
    } else if (varName === 'tunnel_url') {
        session.tunnelUrl = value.trim();
    } else if (varName === 'tunnel_token') {
        session.tunnelToken = value.trim();
    } else if (varName === 'tunnel_id') {
        session.tunnelId = value.trim();
    } else {
        return false;
    }
    return true;
}
/**
* Fetch linkspan's /api/v1/status endpoint through the tunnel.
*/

async function pollLinkspanStatus(session: Runtime, ctx: CSExtensionContext): Promise<boolean> {
    try {
        const baseUrl = session.tunnelUrl!.replace(/\/$/, '');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`${baseUrl}/api/v1/status`, {
            signal: controller.signal,
            headers: session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {},
        });
        clearTimeout(timeout);
        if (!resp.ok) { return false; }
        const status: any = await resp.json();
        // Apply captured outputs
        for (const [varName, value] of Object.entries(status.outputs)) {
            _applyWorkflowCapture(session, varName, String(value));
        }
        // Handle workflow failure
        if (status.state === 'failed' && status.error) {
            session.status = 'Failed';
            session.errorMessage = status.error;
        }
        ctx.outputChannel.appendLine(`[poll] linkspan status: ${status.state} (step ${status.currentStep}/${status.totalSteps}${status.stepName ? ` — ${status.stepName}` : ''})`);
        return true;
    } catch {
        return false;
    }
}
/**
* Poll linkspan for workflow status.  Two modes:
* - Bootstrap (no tunnelUrl yet): one SSH call to read SLURM stderr logs and
*   discover the tunnel URL from the first workflow step.
* - Direct (tunnelUrl known): fetch /api/v1/status through the tunnel.
*/
export async function pollLinkspanWorkflow(session: Runtime, ctx: CSExtensionContext): Promise<void> {
    if (!session.slurmJobId) { return; }

    // All workflow variables captured — nothing left to poll for
    if (session.tunnelUrl && session.tunnelToken && session.sshPort && session.logPort) { return; }

    // Once tunnel URL is known, use the API exclusively
    if (session.tunnelUrl) {
        await pollLinkspanStatus(session, ctx);
        return;
    }

    // Bootstrap: parse SLURM stderr logs via SSH to discover tunnel_url
    const logPrefix = session.noSlurm ? 'linkspan-plain-' : 'linkspan-session-';
    const logId = session.noSlurm ? session.slurmJobId.replace('pid-', '') : session.slurmJobId;
    const logFile = `$HOME/.cybershuttle/logs/${logPrefix}${logId}.err`;
    try {
        const result = await ctx.ssh.runRemoteCommand(session.host, `if [ -f ${logFile} ]; then tail -c 65536 ${logFile}; fi`);
        if (result.code !== 0 || !result.stdout) { return; }

        for (const line of result.stdout.split('\n')) {
            const cap = line.match(/workflow: captured (\S+) = (.+)/);
            if (cap) {
                _applyWorkflowCapture(session, cap[1], cap[2]);
                continue;
            }
            // Capture remote linkspan's HTTP server port from "listening on 0.0.0.0:<port>"
            if (!session.remoteServerPort) {
                const listenMatch = line.match(/listening on [\d.]+:(\d+)/);
                if (listenMatch && !line.includes('SSH') && !line.includes('log stream')) {
                    session.remoteServerPort = parseInt(listenMatch[1], 10);
                }
            }
            const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): (.+)/);
            if (errMatch) {
                session.status = 'Failed';
                session.errorMessage = `${errMatch[1]}: ${errMatch[2].trim()}`;
            }
        }
    } catch {
        // SSH error — skip this cycle
    }
}

/**
* Ensure the linkspan binary is available locally by downloading the latest
* release from GitHub if not already cached at ~/.cybershuttle/bin/linkspan.
*/
export async function ensureLocalLinkspan(ctx: CSExtensionContext): Promise<string> {
    const binDir = path.join(os.homedir(), '.cybershuttle', 'bin');
    const binPath = path.join(binDir, 'linkspan');
    if (ctx.linkspanDownloaded && fs.existsSync(binPath)) {
        return binPath;
    }

    const deployStart = Date.now();
    ctx.metrics.record('linkspan_deploy', 'in_progress', { deploy_type: 'local' });

    const platformMap: Record<string, string> = { darwin: 'Darwin', linux: 'Linux', win32: 'Windows' };
    const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'arm64' };
    const osName = platformMap[process.platform];
    const archName = archMap[process.arch];
    if (!osName || !archName) {
        const errMsg = `Unsupported platform: ${process.platform}/${process.arch}`;
        ctx.metrics.record('linkspan_deploy', 'failure', { deploy_type: 'local' }, Date.now() - deployStart, errMsg);
        throw new Error(errMsg);
    }

    const assetName = `linkspan_${osName}_${archName}.tar.gz`;
    const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;

    fs.mkdirSync(binDir, { recursive: true });

    // Check if local binary is already at the latest version
    if (fs.existsSync(binPath)) {
        try {
            const localVersion = spawnSync(binPath, ['--version'], { timeout: 5000 }).stdout?.toString().trim();
            // Resolve /latest/ redirect to get the actual release tag
            const latestTag = spawnSync('curl', ['-fsSLI', '-o', '/dev/null', '-w', '%{url_effective}', 'https://github.com/cyber-shuttle/linkspan/releases/latest'], { timeout: 10000 }).stdout?.toString().trim();
            const remoteVersion = latestTag?.split('/').pop(); // e.g. "v0.3.1"
            if (localVersion && remoteVersion && localVersion.includes(remoteVersion)) {
                ctx.outputChannel.appendLine(`linkspan is up to date (${localVersion})`);
                ctx.linkspanDownloaded = true;
                ctx.metrics.record('linkspan_deploy', 'success', { deploy_type: 'local', skipped: 'up_to_date' }, Date.now() - deployStart);
                return binPath;
            }
            ctx.outputChannel.appendLine(`linkspan update available: local=${localVersion}, remote=${remoteVersion}`);
        } catch {
            // Version check failed — fall through to download
        }
    }

    ctx.outputChannel.appendLine(`Downloading linkspan from ${downloadUrl}`);

    try {
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('bash', ['-c', `curl -fsSL "${downloadUrl}" | tar -xz -C "${binDir}" linkspan && chmod +x "${binPath}"`], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
            proc.on('close', (code) => {
                if (code === 0) { resolve(); }
                else { reject(new Error(`Failed to download linkspan: ${stderr}`)); }
            });
            proc.on('error', reject);
        });

        ctx.linkspanDownloaded = true;
        ctx.outputChannel.appendLine('linkspan downloaded to ' + binPath);
        ctx.metrics.record('linkspan_deploy', 'success', { deploy_type: 'local' }, Date.now() - deployStart);
        return binPath;
    } catch (err: any) {
        ctx.metrics.record('linkspan_deploy', 'failure', { deploy_type: 'local' }, Date.now() - deployStart, err.message);
        throw err;
    }
}

/**
* Spawn a linkspan process for a local session, wire up output parsing and lifecycle handlers.
* Used by both testLocal() (new sessions) and _resumeLocalSession() (restarted sessions).
*/
export async function launchLinkspanProcess(session: Runtime, authToken: string,
    ctx: CSExtensionContext, refresh: () => void): Promise<void> {
    const linkspanPath = await ensureLocalLinkspan(ctx);
    const proc = spawn(linkspanPath, ['--port', '0', '--tunnel-auth-token', authToken, '--workflow', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    ctx.localProcesses.set(session.id, proc);
    session.localPid = proc.pid;
    session.status = 'Active';
    saveSessions(ctx);
    refresh();

    proc.stdin!.write(session.script);
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
                _applyWorkflowCapture(session, varName, value);
                if (varName === 'tunnel_url') {
                    ctx.metrics.record('tunnel_create', 'success', { tunnel_type: ctx.tunnelManager.getProvider(), target_host: session.host });
                }
                saveSessions(ctx);
                refresh();
                continue;
            }

            // Detect workflow step errors
            const errMatch = line.match(/workflow: workflow step \d+ \(([^)]+)\): (.+)/);
            if (errMatch) {
                const [, stepName, errMsg] = errMatch;
                session.status = 'Failed';
                session.errorMessage = `${stepName}: ${errMsg.trim()}`;
                saveSessions(ctx);
                refresh();
                vscode.window.showErrorMessage(`Linkspan workflow failed — ${stepName}: ${errMsg.trim()}`);
                ctx.metrics.record('tunnel_create', 'failure', { tunnel_type: ctx.tunnelManager.getProvider(), target_host: session.host }, undefined, session.errorMessage);
                continue;
            }

            // Detect fatal errors (e.g. "failed to listen", panic, etc.)
            const fatal = line.match(/(?:fatal|FATAL|panic): (.+)/);
            if (fatal) {
                session.status = 'Failed';
                session.errorMessage = fatal[1].trim();
                saveSessions(ctx);
                refresh();
                vscode.window.showErrorMessage(`Linkspan error: ${fatal[1].trim()}`);
            }
        }
    };

    proc.stdout!.on('data', (data: Buffer) => {
        const text = data.toString();
        ctx.outputChannel.appendLine(text.trimEnd());
        parseOutput(text);
    });

    proc.stderr!.on('data', (data: Buffer) => {
        const text = data.toString();
        ctx.outputChannel.appendLine(text.trimEnd());
        parseOutput(text);
    });

    proc.on('close', (code) => {
        ctx.localProcesses.delete(session.id);
        // During extension disposal, don't update session state — we want
        // sessions to remain Active so they're resumed on next startup.
        if (ctx.disposing) { return; }
        const s = findRuntime(session.id, ctx)?.runtime;
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
            saveSessions(ctx);
            refresh();
        }
        ctx.outputChannel.appendLine(`\n--- Local linkspan session ended (exit code ${code}) ---`);
    });

    proc.on('error', (err) => {
        ctx.localProcesses.delete(session.id);
        if (ctx.disposing) { return; }
        const s = findRuntime(session.id, ctx)?.runtime;
        if (s) {
            s.status = 'Failed';
            s.errorMessage = err.message;
            s.localPid = undefined;
            saveSessions(ctx);
            refresh();
        }
        ctx.outputChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`Local linkspan failed: ${err.message}`);
    });
}

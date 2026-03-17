import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allRuntimes, findRuntime, Runtime } from './WorkspaceManager.js';
import { CSExtensionContext } from './ExtensionContext.js';
import { saveSessions } from './SessionManager.js';
import * as vscode from 'vscode';
import { checkJobViaSsh } from './SLURMManager.js';
import { deleteDevTunnel } from './DevTunnelManager.js';



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


/**
* Stop the local linkspan for the current workspace.
*/
export function stopLocalLinkspan(ctx: CSExtensionContext, sendRuntimeUpdates: () => void): void {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        return;
    }
    // Clear connection state on all sessions using this linkspan
    for (const session of allRuntimes(ctx.workspaces)) {
        if (session.localWorkdir === workspacePath && session.connectionId) {
            session.connectionId = undefined;
            session._portMap = undefined;
        }
    }
    ctx.localLinkspan.stop(workspacePath);
    saveSessions(ctx);
    ctx.outputChannel.appendLine(`[linkspan-local] Stopped for ${workspacePath}`);
    vscode.window.showInformationMessage('Linkspan stopped');
    sendRuntimeUpdates();
}


/**
* Auto-start the local linkspan for the current workspace on extension activation.
* Retries with exponential backoff on failure.
*/
export async function autoStartLinkspan(ctx: CSExtensionContext, sendRuntimeUpdates: () => void, refreshSessionsView: () => void, attempt = 0): Promise<void> {
    const MAX_RETRIES = 3;
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        return;
    }
    // Show starting state on the card
    ctx.linkspanStartingPath = workspacePath;
    refreshSessionsView();
    try {
        await ensureLocalLinkspan(ctx);
        const localSession = allRuntimes(ctx.workspaces).find(r => r.isLocal && r.status === 'Local');
        const tunnelName = localSession ? `ls-local-${localSession.id}` : undefined;
        // Pre-delete stale tunnel so linkspan creates a fresh one
        if (tunnelName) {
            deleteDevTunnel(tunnelName, ctx);
        }
        await ctx.localLinkspan.ensure(workspacePath, tunnelName);
        ctx.outputChannel.appendLine('[linkspan-local] Auto-started successfully');
        sendRuntimeUpdates();
        // Announce the new local linkspan to any active remote sessions
        await _reconnectActiveSessions(ctx, workspacePath, sendRuntimeUpdates);
    } catch (err: any) {
        ctx.outputChannel.appendLine(`[linkspan-local] Auto-start failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message}`);
        if (attempt < MAX_RETRIES) {
            const delay = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
            setTimeout(() => autoStartLinkspan(ctx, sendRuntimeUpdates, refreshSessionsView, attempt + 1), delay);
        }
    } finally {
        ctx.linkspanStartingPath = undefined;
        refreshSessionsView();
    }
}

export async function startLocalLinkspan(ctx: CSExtensionContext, refreshSessionsView: () => void, sendRuntimeUpdates: () => void): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    // Immediate UI feedback — mark as starting
    ctx.linkspanStartingPath = workspacePath;
    refreshSessionsView();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Starting Linkspan',
        cancellable: false,
    }, async (progress) => {
        try {
            progress.report({ message: 'Downloading latest linkspan...' });
            await ensureLocalLinkspan(ctx);
            progress.report({ message: 'Starting...' });
            const localSession = allRuntimes(ctx.workspaces).find(r => r.isLocal && r.status === 'Local');
            const tunnelName = localSession ? `ls-local-${localSession.id}` : undefined;
            if (tunnelName) { deleteDevTunnel(tunnelName, ctx); }
            await ctx.localLinkspan.ensure(workspacePath, tunnelName);
            const info = ctx.localLinkspan.get(workspacePath);
            if (info) {
                ctx.outputChannel.appendLine(`[linkspan-local] Started: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}`);
            }
            vscode.window.showInformationMessage('Linkspan started');
        } catch (err: any) {
            ctx.outputChannel.appendLine(`[linkspan-local] Start failed: ${err.message}`);
            vscode.window.showErrorMessage(`Linkspan start failed: ${err.message}`);
        } finally {
            ctx.linkspanStartingPath = undefined;
            refreshSessionsView();
        }
    });
    // Reconnect any active sessions through the new linkspan
    await _reconnectActiveSessions(ctx, workspacePath, sendRuntimeUpdates);
}

/**
 * Restart the local linkspan: download latest binary, stop existing, start fresh.
 */
export async function restartLocalLinkspan(ctx: CSExtensionContext, refreshSessionsView: () => void,
    sendRuntimeUpdates: () => void, sessionId?: string): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    // Immediate UI feedback — mark as restarting
    ctx.linkspanStartingPath = workspacePath;
    refreshSessionsView();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Restarting Linkspan',
        cancellable: false,
    }, async (progress) => {
        try {
            progress.report({ message: 'Downloading latest linkspan...' });
            await ensureLocalLinkspan(ctx);
            progress.report({ message: 'Stopping current instance...' });
            ctx.localLinkspan.stop(workspacePath);
            progress.report({ message: 'Starting fresh instance...' });
            const localSession = allRuntimes(ctx.workspaces).find(r => r.isLocal && r.status === 'Local');
            const tunnelName = localSession ? `ls-local-${localSession.id}` : undefined;
            if (tunnelName) {
                deleteDevTunnel(tunnelName, ctx);
            }
            await ctx.localLinkspan.ensure(workspacePath, tunnelName);
            const info = ctx.localLinkspan.get(workspacePath);
            if (info) {
                ctx.outputChannel.appendLine(`[linkspan-local] Restarted: tunnel=${info.tunnelId}, ssh=${info.sshPort}, http=${info.serverPort}`);
            }
            vscode.window.showInformationMessage('Linkspan restarted with latest version');
        } catch (err: any) {
            ctx.outputChannel.appendLine(`[linkspan-local] Restart failed: ${err.message}`);
            vscode.window.showErrorMessage(`Linkspan restart failed: ${err.message}`);
        } finally {
            ctx.linkspanStartingPath = undefined;
            refreshSessionsView();
        }
    });
    // Reconnect any active sessions through the new linkspan
    await _reconnectActiveSessions(ctx, workspacePath, sendRuntimeUpdates);
}

/**
* After linkspan starts or restarts, clear stale tunnel connections on all
* active sessions and re-establish them through the new linkspan instance.
* Also announces the new local linkspan's tunnel to each remote linkspan
* so they can reconnect back (for FUSE/storage overlay).
*/
async function _reconnectActiveSessions(ctx: CSExtensionContext, workspacePath: string, sendRuntimeUpdates: () => void): Promise<void> {
    const info = ctx.localLinkspan.get(workspacePath);
    if (!info) {
        ctx.outputChannel.appendLine(`[linkspan-local] _reconnectActiveSessions: no local linkspan info for ${workspacePath}`);
        return;
    }
    const allRemote = allRuntimes(ctx.workspaces).filter(rt => !rt.isLocal);
    ctx.outputChannel.appendLine(`[linkspan-local] _reconnectActiveSessions: ${allRemote.length} remote session(s), checking for workspace=${workspacePath}`);
    for (const rt of allRemote) {
        ctx.outputChannel.appendLine(`[linkspan-local]   session ${rt.id}: status=${rt.status}, localWorkdir=${rt.localWorkdir}, hasTunnelId=${!!rt.tunnelId}, hasTunnelToken=${!!rt.tunnelToken}`);
    }
    const activeSessions = allRemote.filter(
        rt => rt.localWorkdir === workspacePath && rt.status === 'Active' && rt.tunnelId && rt.tunnelToken
    );
    if (activeSessions.length === 0) {
        ctx.outputChannel.appendLine(`[linkspan-local] _reconnectActiveSessions: no matching active sessions`);
        return;
    }
    ctx.outputChannel.appendLine(`[linkspan-local] Reconnecting ${activeSessions.length} active session(s) through new linkspan`);
    for (const session of activeSessions) {
        // Clear old connection state — the old linkspan instance is gone
        session.connectionId = undefined;
        session._portMap = undefined;
        session.sshTunnelLocalPort = undefined;
    }

    // Tell each remote linkspan to reconnect to the new local tunnel.
    // Strategy: SSH into the remote host and call the remote linkspan's
    // local REST API with curl. Falls back to tunnel URL announce.
    for (const session of activeSessions) {
        const provider = 'devtunnel';  // TODO: get from session when multi-provider
        let reconnected = false;

        // Primary: SSH + curl to remote linkspan's local API
        if (session.remoteServerPort && session.computeNode) {
            try {
                const payload = JSON.stringify({
                    provider,
                    tunnelId: info.tunnelId,
                    token: info.tunnelToken,
                });
                // Run curl on the compute node (linkspan listens on localhost)
                const curlCmd = `curl -sf -X POST http://127.0.0.1:${session.remoteServerPort}/api/v1/tunnels/connect -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'`;
                const sshTarget = session.computeNode || session.host;
                const result = await ctx.ssh.runRemoteCommand(sshTarget, curlCmd);
                if (result.code === 0) {
                    ctx.outputChannel.appendLine(`[linkspan-local] Reconnected remote ${session.id} to new local tunnel via SSH+curl`);
                    reconnected = true;
                } else {
                    ctx.outputChannel.appendLine(`[linkspan-local] SSH+curl reconnect failed for ${session.id}: ${result.stdout}`);
                }
            } catch (err: any) {
                ctx.outputChannel.appendLine(`[linkspan-local] SSH+curl error for ${session.id}: ${err.message}`);
            }
        }

        // Fallback: try announce via tunnel URL
        if (!reconnected) {
            try {
                await _announceLocalLinkspan(session, info, ctx);
            } catch (err: any) {
                ctx.outputChannel.appendLine(`[linkspan-local] Announce error for ${session.id}: ${err.message}`);
            }
        }

        // Verify session is still alive
        try {
            await checkJobViaSsh(session, ctx);
            ctx.outputChannel.appendLine(`[linkspan-local] Remote ${session.id} job status: ${session.status}`);
        } catch (err: any) {
            ctx.outputChannel.appendLine(`[linkspan-local] SSH check failed for ${session.id}: ${err.message}`);
        }
    }

    saveSessions(ctx);
    sendRuntimeUpdates();
}

/**
* Announce the local linkspan's tunnel info to a remote linkspan via its
* metadata API. This allows the remote linkspan to reconnect back to the
* new local instance (e.g. for FUSE overlay, storage sync).
*/
async function _announceLocalLinkspan(session: Runtime, localInfo: import('./LocalLinkspan.js').LocalLinkspanInfo, ctx: CSExtensionContext): Promise<void> {
    if (!session.tunnelUrl || !session.tunnelToken) { return; }
    const baseUrl = session.tunnelUrl.replace(/\/$/, '');
    const payload = {
        tunnelId: localInfo.tunnelId,
        tunnelToken: localInfo.tunnelToken,
        tunnelUrl: localInfo.tunnelUrl,
        sshPort: localInfo.sshPort,
        workspacePath: localInfo.workspacePath,
    };
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const resp = await fetch(`${baseUrl}/api/v1/metadata/local_linkspan`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...(session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {}),
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (resp.ok) {
            ctx.outputChannel.appendLine(`[linkspan-local] Announced local linkspan to remote ${session.id} (${session.host})`);
        } else {
            ctx.outputChannel.appendLine(`[linkspan-local] Announce failed for ${session.id}: ${resp.status} ${await resp.text()}`);
        }
    } catch (err: any) {
        ctx.outputChannel.appendLine(`[linkspan-local] Announce failed for ${session.id}: ${err.message}`);
    }
}

/**
* Check if linkspan is alive by hitting /api/v1/health through the tunnel.
*/
export async function checkLinkspanHealth(session: Runtime, ctx: CSExtensionContext): Promise<boolean> {
    if (!session.tunnelUrl) { return false; }
    const baseUrl = session.tunnelUrl.replace(/\/$/, '');
    const url = `${baseUrl}/api/v1/health`;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: session.tunnelToken ? { Authorization: `Bearer ${session.tunnelToken}` } : {},
        });
        clearTimeout(timeout);
        if (!resp.ok) {
            ctx.outputChannel.appendLine(`[health] ${url} returned ${resp.status}`);
        }
        return resp.ok;
    } catch (err: any) {
        ctx.outputChannel.appendLine(`[health] ${url} failed: ${err.message}`);
        return false;
    }
}

/**
* Deploy the linkspan binary to a remote host by downloading the latest
* release from GitHub (https://github.com/cyber-shuttle/linkspan).
*/
export async function deployLinkspan(hostName: string, ctx: CSExtensionContext, token?: vscode.CancellationToken): Promise<void> {
    const deployStart = Date.now();
    ctx.metrics.record('linkspan_deploy', 'in_progress', { deploy_type: 'remote', target_host: hostName });
    try {
        // Detect remote architecture
        const archResult = await ctx.ssh.runRemoteCommand(hostName, 'uname -m', token);
        if (archResult.code !== 0) {
            throw new Error('Failed to detect remote architecture');
        }
        let arch = archResult.stdout.trim();
        if (arch === 'aarch64') { arch = 'arm64'; }

        const assetName = `linkspan_Linux_${arch}.tar.gz`;
        const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/${assetName}`;

        // Check if remote binary is already at the latest version
        const versionCheck = await ctx.ssh.runRemoteCommand(hostName, [
            `LOCAL_VER=$(~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo "")`,
            `REMOTE_VER=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | grep -oP '[^/]+$' || echo "")`,
            `echo "LOCAL=$LOCAL_VER REMOTE=$REMOTE_VER"`,
            `if [ -n "$LOCAL_VER" ] && [ -n "$REMOTE_VER" ] && echo "$LOCAL_VER" | grep -q "$REMOTE_VER"; then echo "UP_TO_DATE"; fi`,
        ].join(' && '), token);

        if (versionCheck.code === 0 && versionCheck.stdout.includes('UP_TO_DATE')) {
            const verLine = versionCheck.stdout.split('\n')[0];
            ctx.outputChannel.appendLine(`linkspan on ${hostName} is up to date (${verLine})`);
            ctx.metrics.record('linkspan_deploy', 'success', { deploy_type: 'remote', target_host: hostName, skipped: 'up_to_date' }, Date.now() - deployStart);
            return;
        }

        // Download latest release from GitHub directly on the remote host
        ctx.outputChannel.appendLine(`Downloading linkspan to ${hostName} from ${downloadUrl}`);
        await ctx.ssh.runRemoteCommand(hostName, `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`, token);
        ctx.outputChannel.appendLine('linkspan deployed to ' + hostName);
        ctx.metrics.record('linkspan_deploy', 'success', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart);
    } catch (err: any) {
        ctx.metrics.record('linkspan_deploy', 'failure', { deploy_type: 'remote', target_host: hostName }, Date.now() - deployStart, err.message);
        throw err;
    }
}

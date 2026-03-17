import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SshManager } from './SshManager';
import * as os from 'os';
import { Runtime } from './WorkspaceManager';
import { CSExtensionContext } from './ExtensionContext';

export const HOST_PREFS_KEY = 'cybershuttle.hostPrefs';

function _clusterInfoDir(): string {
    const dir = path.join(os.homedir(), '.cybershuttle', 'cluster-info');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    return dir;
}
function loadCachedClusterInfo(hostName: string): { partitions: any; remoteHome?: string; fetchedAt: number } | null {
    try {
        const filePath = path.join(_clusterInfoDir(), `${hostName}.json`);
        if (!fs.existsSync(filePath)) { return null; }
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return null; }
}

function saveCachedClusterInfo(hostName: string, partitions: any, remoteHome?: string) {
    try {
        const filePath = path.join(_clusterInfoDir(), `${hostName}.json`);
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify({ partitions, remoteHome, fetchedAt: Date.now() }, null, 2));
        fs.renameSync(tmpPath, filePath);
    } catch { /* best effort */ }
}

function getHostPrefs(workspaceState: vscode.Memento, host: string): { allocation?: string; partition?: string } {
    const all = workspaceState.get<Record<string, { allocation?: string; partition?: string }>>(HOST_PREFS_KEY, {});
    return all[host] || {};
}

export function saveHostPrefs(workspaceState: vscode.Memento, host: string, prefs: { allocation?: string; partition?: string }) {
    const all = workspaceState.get<Record<string, { allocation?: string; partition?: string }>>(HOST_PREFS_KEY, {});
    all[host] = prefs;
    workspaceState.update(HOST_PREFS_KEY, all);
}

/**
* Query SLURM partition and account info for the current user on a remote host
* using scripts/info.sh. Sends a partition→info mapping to the webview
* to populate the Partition and Allocation dropdowns.
* Serves cached data immediately if available, then refreshes in background.
*/
export async function queryAssociations(hostName: string, outputChannel: vscode.OutputChannel,
    ssh: SshManager, extensionUri: vscode.Uri, cachedRemoteHome: Map<string, string>,
    associationsCts: Map<string, vscode.CancellationTokenSource>, workspaceState: vscode.Memento,
    postSessionsMessage: (msg: unknown) => void): Promise<void> {
    // Serve cached data immediately if available
    const cached = loadCachedClusterInfo(hostName);
    if (cached && cached.partitions && Object.keys(cached.partitions).length > 0) {
        if (cached.remoteHome) { cachedRemoteHome.set(hostName, cached.remoteHome); }
        const savedPrefs = getHostPrefs(workspaceState, hostName);
        postSessionsMessage({ type: 'associations', host: hostName, partitions: cached.partitions, savedPrefs });
    }

    // Cancel any in-flight fetch for this host
    const prev = associationsCts.get(hostName);
    if (prev) { prev.cancel(); }

    const cts = new vscode.CancellationTokenSource();
    associationsCts.set(hostName, cts);

    const hasCached = cached && cached.partitions && Object.keys(cached.partitions).length > 0;

    await vscode.window.withProgress({
        location: hasCached ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title: `Querying cluster info on ${hostName}`,
        cancellable: true,
    }, async (progress, progressToken) => {
        // Merge: cancel if either the toast Cancel or webview Stop fires
        const mergedDisposable = progressToken.onCancellationRequested(() => cts.cancel());
        const token = cts.token;

        outputChannel.appendLine(`\n--- Querying SLURM partition info on ${hostName} ---`);
        progress.report({ message: 'Fetching partitions and accounts...' });

        try {
            const infoScript = fs.readFileSync(
                path.join(extensionUri.fsPath, 'scripts', 'info.sh'),
                'utf-8'
            );
            const result = await ssh.runRemoteCommand(
                hostName,
                '',
                token,
                `echo "HOMEDIR:$HOME"\n` + infoScript + '\nexit 0\n'
            );

            outputChannel.appendLine(`info.sh exit code: ${result.code}`);
            if (result.stderr) {
                outputChannel.appendLine(`info.sh stderr: ${result.stderr}`);
            }

            if (result.code === 0) {
                outputChannel.appendLine(`info.sh stdout: [${result.stdout}]`);

                const lines = result.stdout.trim().split('\n');

                // Extract remote home directory from first line
                const homeLine = lines.find((l: string) => l.startsWith('HOMEDIR:'));
                if (homeLine) {
                    const remoteHome = homeLine.slice('HOMEDIR:'.length).trim();
                    if (remoteHome) {
                        cachedRemoteHome.set(hostName, remoteHome);
                        outputChannel.appendLine(`Remote home for ${hostName}: ${remoteHome}`);
                    }
                }
                const partitions: { [name: string]: { accounts: string[]; nodes: number; maxCpus: number; maxMemMb: number; maxGpus: number; gpuTypes: string[] } } = {};

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line || line.startsWith('partition|')) { continue; }
                    const parts = line.split('|');
                    // 7-column format: partition|nodes|max_cpus|max_mem_mb|max_gpus|gpu_types|accounts
                    if (parts.length >= 7) {
                        const name = parts[0].trim();
                        const nodes = parseInt(parts[1].trim(), 10) || 0;
                        const maxCpus = parseInt(parts[2].trim(), 10) || 0;
                        const maxMemMb = parseInt(parts[3].trim(), 10) || 0;
                        const maxGpus = parseInt(parts[4].trim(), 10) || 0;
                        const gpuTypes = parts[5].trim()
                            ? parts[5].trim().split(',').filter((t: string) => t.length > 0) : [];
                        const accounts = parts[6].trim()
                            ? parts[6].trim().split(',').filter((a: string) => a.length > 0) : [];
                        // Validate: partition name must be alphanumeric/hyphens/underscores, nodes > 0
                        if (name && /^[a-zA-Z0-9_-]+$/.test(name) && nodes > 0) {
                            partitions[name] = { accounts, nodes, maxCpus, maxMemMb, maxGpus, gpuTypes };
                        }
                    }
                }

                // Fallback: if info.sh produced no partition rows, get basic list from sinfo
                if (Object.keys(partitions).length === 0) {
                    outputChannel.appendLine('No partitions from info.sh, falling back to sinfo');
                    const fallback = await ssh.runRemoteCommand(
                        hostName,
                        '',
                        token,
                        `sinfo -h -o "%P %D %c" 2>/dev/null | sed 's/*//g'\nexit 0\n`
                    );
                    outputChannel.appendLine(`Fallback sinfo exit code: ${fallback.code}`);
                    outputChannel.appendLine(`Fallback sinfo stdout: [${fallback.stdout}]`);
                    if (fallback.stderr) {
                        outputChannel.appendLine(`Fallback sinfo stderr: ${fallback.stderr}`);
                    }
                    if (fallback.code === 0 && fallback.stdout.trim()) {
                        for (const line of fallback.stdout.trim().split('\n')) {
                            const cols = line.trim().split(/\s+/);
                            if (cols.length >= 3 && cols[0]) {
                                partitions[cols[0]] = {
                                    accounts: [],
                                    nodes: parseInt(cols[1], 10) || 0,
                                    maxCpus: parseInt(cols[2], 10) || 0,
                                    maxMemMb: 0,
                                    maxGpus: 0,
                                    gpuTypes: [],
                                };
                            }
                        }
                    }
                    outputChannel.appendLine(`Fallback parsed ${Object.keys(partitions).length} partitions`);
                }

                progress.report({ message: 'Done.' });
                saveCachedClusterInfo(hostName, partitions, cachedRemoteHome.get(hostName));
                const savedPrefs = getHostPrefs(workspaceState, hostName);
                postSessionsMessage({ type: 'associations', host: hostName, partitions, savedPrefs });
            } else {
                outputChannel.appendLine(`Command exited with code ${result.code}`);
                if (result.stderr) {
                    outputChannel.appendLine(result.stderr);
                }
                postSessionsMessage({ type: 'associationsError', host: hostName, error: result.stderr || `exit code ${result.code}` });
            }
            outputChannel.appendLine(`--- End of partition info ---\n`);
        } catch (err: any) {
            if (err.cancelled) {
                outputChannel.appendLine('Partition query cancelled by user');
                postSessionsMessage({ type: 'associationsCancelled', host: hostName });
            } else {
                outputChannel.appendLine(`Error: ${err.message}`);
                postSessionsMessage({ type: 'associationsError', host: hostName, error: err.message });
            }
        } finally {
            mergedDisposable.dispose();
            associationsCts.delete(hostName);
        }
    });
}


/**
     * SSH-based job status check (squeue for SLURM, kill -0 for plain processes).
     * Used as fallback when tunnel health check fails or tunnel not yet established.
     */
export async function checkJobViaSsh(session: Runtime, ctx: CSExtensionContext): Promise<void> {
    if (session.noSlurm) {
        const pid = session.slurmJobId?.replace('pid-', '');
        if (pid) {
            const result = await ctx.ssh.runRemoteCommand(session.host, `kill -0 ${pid} 2>/dev/null && echo RUNNING || echo STOPPED`);
            if (result.stdout.trim() === 'RUNNING') {
                session.status = 'Active';
                session.errorMessage = undefined;
            } else {
                session.status = 'Completed';
                session.errorMessage = undefined;
            }
        }
    } else {
        const squeueStart = Date.now();
        const result = await ctx.ssh.runRemoteCommand(session.host, `squeue -j ${session.slurmJobId} -h -o "%T %N"`);
        ctx.metrics.record('sinfo_fetch', 'success', { cluster: session.host, raw_output_truncated: result.stdout.slice(0, 200) }, Date.now() - squeueStart);
        const parts0 = result.stdout.trim().split(/\s+/);
        const state = parts0[0] || '';
        const nodeName = parts0[1] || '';
        if (result.code === 0 && state) {
            if (state === 'RUNNING') {
                session.status = 'Active';
                session.errorMessage = undefined;
                if (nodeName && !session.computeNode) { session.computeNode = nodeName; }
            } else if (state === 'PENDING' || state === 'CONFIGURING') {
                session.status = 'Pending';
                session.errorMessage = undefined;
            } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT' || state === 'NODE_FAIL' || state === 'OUT_OF_MEMORY') {
                session.status = 'Failed';
                session.errorMessage = `Job ${state}`;
            }
        } else {
            try {
                const sacctResult = await ctx.ssh.runRemoteCommand(session.host, `sacct -j ${session.slurmJobId} -n -o State%20,ExitCode,Reason%40 --parsable2 2>/dev/null | head -1`);
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
        ctx.outputChannel.appendLine(`Job ${session.slurmJobId} on ${session.host} status: ${session.status} ${session.errorMessage ? `(${session.errorMessage})` : ''}`);
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { allRuntimes, Runtime, Workspace } from './WorkspaceManager';
import { CSExtensionContext } from './ExtensionContext';
import { TunnelCredentials } from './TunnelManager';
import { launchLinkspanProcess } from './LinkspanManager';

const TIER3_FIELDS: (keyof Runtime)[] = [
    'connectionId', '_portMap', 'syncProgress',
];

/**
* Clear Tier 2 + Tier 3 fields and credentials from a session.
*/
export function clearSessionFields(session: Runtime): void {
    session.script = undefined;
    session.tunnelUrl = undefined;
    session.tunnelToken = undefined;
    session.tunnelId = undefined;
    session.sshPort = undefined;
    session.logPort = undefined;
    session.computeNode = undefined;
    session.sshTunnelLocalPort = undefined;
    session.connectionId = undefined;
    session._portMap = undefined;
    session.errorMessage = undefined;
}

export function saveSessions(ctx: CSExtensionContext) {
    try {
        // Stamp terminatedAt on any terminal session that doesn't have one yet
        for (const r of allRuntimes(ctx.workspaces)) {
            if ((r.status === 'Completed' || r.status === 'Failed') && !r.terminatedAt) {
                r.terminatedAt = Date.now();
            }
        }
        // Deep-clone workspaces and strip Tier 3 (ephemeral) fields before persisting
        const cleaned = ctx.workspaces.map(ws => ({
            ...ws,
            runtimes: ws.runtimes.map(r => {
                const copy: any = { ...r };
                for (const key of TIER3_FIELDS) {
                    delete copy[key];
                }
                return copy;
            }),
        }));
        const tmpPath = ctx.sessionsFilePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(cleaned, null, 2));
        fs.renameSync(tmpPath, ctx.sessionsFilePath);
        ctx.lastWriteTime = Date.now();
    } catch (err: any) {
        ctx.outputChannel.appendLine(`[sessions] Failed to save sessions file: ${err.message}`);
    }
}

/**
* Merge sessions from disk into the in-memory state without destroying
* ephemeral Tier 3 fields (connectionId, _portMap, etc.).
* New workspaces/sessions from other windows are added; existing sessions
* get their persisted fields updated but keep their live tunnel state.
*/
export function mergeSessionsFromFile(ctx: CSExtensionContext) {
    let rawData: any;
    try {
        if (fs.existsSync(ctx.sessionsFilePath)) {
            rawData = JSON.parse(fs.readFileSync(ctx.sessionsFilePath, 'utf-8'));
        }
    } catch { return; }
    if (!Array.isArray(rawData)) { return; }

    // Build lookup of existing in-memory sessions by ID
    const existingById = new Map<string, Runtime>();
    for (const rt of allRuntimes(ctx.workspaces)) {
        existingById.set(rt.id, rt);
    }
    const existingWsById = new Map<string, Workspace>();
    for (const ws of ctx.workspaces) {
        existingWsById.set(ws.id, ws);
    }

    for (const wsData of rawData) {
        if (!wsData?.id || !Array.isArray(wsData.runtimes)) { continue; }
        const existingWs = existingWsById.get(wsData.id);
        if (!existingWs) {
            // New workspace from another window — add it
            ctx.workspaces.push({
                id: wsData.id,
                directoryPath: wsData.directoryPath,
                directoryName: wsData.directoryName || path.basename(wsData.directoryPath) || wsData.directoryPath,
                runtimes: wsData.runtimes.map((r: any) => ({
                    ...r,
                    submittedAt: new Date(r.submittedAt),
                })),
            });
            continue;
        }
        for (const rtData of wsData.runtimes) {
            if (!rtData?.id) { continue; }
            const existing = existingById.get(rtData.id);
            if (!existing) {
                // New session from another window — add it
                existingWs.runtimes.push({
                    ...rtData,
                    submittedAt: new Date(rtData.submittedAt),
                });
            } else {
                // Existing session — update persisted fields, preserve Tier 3
                const saved: Record<string, any> = {};
                for (const key of TIER3_FIELDS) {
                    saved[key] = (existing as any)[key];
                }
                Object.assign(existing, rtData, { submittedAt: new Date(rtData.submittedAt) });
                for (const key of TIER3_FIELDS) {
                    (existing as any)[key] = saved[key];
                }
            }
        }
        // Remove sessions that are no longer in the file (deleted by another window)
        const fileIds = new Set(wsData.runtimes.map((r: any) => r.id));
        existingWs.runtimes = existingWs.runtimes.filter(r => fileIds.has(r.id));
    }
    // Remove workspaces that are no longer in the file
    const fileWsIds = new Set(rawData.map((ws: any) => ws.id));
    // remove all items from workspaces and replace with new ones
    ctx.workspaces.splice(0, ctx.workspaces.length, ...ctx.workspaces.filter(ws => fileWsIds.has(ws.id)));
}

/**
     * Re-launch a local linkspan session whose process died (e.g. after VS Code restart).
     * Clears stale runtime state, cleans up the old tunnel, and re-runs the saved workflow.
     */
async function resumeLocalSession(session: Runtime, ctx: CSExtensionContext, refresh: () => void): Promise<void> {
    ctx.outputChannel.appendLine(`\n--- Resuming local session ${session.id} ---`);

    // Clear stale runtime state but preserve tunnel info (tunnelUrl,
    // tunnelToken, tunnelId) — if the tunnel is still live the user
    // can reconnect immediately.  The linkspan workflow will overwrite
    // these values once it re-captures them.
    session.localPid = undefined;
    session.sshPort = undefined;
    session.logPort = undefined;
    session.status = 'Submitting';
    saveSessions(ctx);

    let creds: TunnelCredentials;
    try {
        creds = await ctx.tunnelManager.getCredentials();
    } catch (err: any) {
        session.status = 'Failed';
        session.errorMessage = `Resume failed: ${err.message}`;
        saveSessions(ctx);
        return;
    }

    try {
        await launchLinkspanProcess(session, creds.authToken, ctx, refresh);
        ctx.outputChannel.appendLine(`Local session ${session.id} resumed`);
    } catch (err: any) {
        session.status = 'Failed';
        session.errorMessage = `Resume failed: ${err.message}`;
        saveSessions(ctx);
    }
}

function reconcileSshConfig(ctx: CSExtensionContext): void {
    const configPath = ctx.internalSshConfigPath;
    try {
        if (!fs.existsSync(configPath)) { return; }
        let content = fs.readFileSync(configPath, 'utf-8');
        const allIds = new Set(allRuntimes(ctx.workspaces).map(r => r.id));
        const terminalIds = new Set(allRuntimes(ctx.workspaces)
            .filter(r => r.status === 'Completed' || r.status === 'Failed' || r.status === 'Idle')
            .map(r => r.id));
        const entryRe = /\n?# CS-Bridge auto-generated for session ([a-f0-9]+)\nHost [^\n]+\n(?:    [^\n]+\n)*/g;
        content = content.replace(entryRe, (match: string, sessionId: string) => {
            if (!allIds.has(sessionId) || terminalIds.has(sessionId)) {
                ctx.outputChannel.appendLine(`[ssh-config] Removed stale entry for session ${sessionId}`);
                return '';
            }
            return match;
        });
        fs.writeFileSync(configPath, content);
    } catch (err: any) {
        ctx.outputChannel.appendLine(`[ssh-config] Failed to reconcile: ${err.message}`);
    }
}

export function loadSessions(ctx: CSExtensionContext, refresh: () => void): void {
    let rawData: any = null;
    // Try to load from shared file first
    try {
        if (fs.existsSync(ctx.sessionsFilePath)) {
            const content = fs.readFileSync(ctx.sessionsFilePath, 'utf-8');
            rawData = JSON.parse(content);
        }
    } catch {
        rawData = null;
    }

    if (Array.isArray(rawData) && rawData.length > 0 && rawData[0].runtimes !== undefined) {
        const validStatuses = new Set(['Local', 'Pending', 'Active', 'Submitting', 'Deploying agent', 'Stopping', 'Failed', 'Completed', 'Idle']);
        ctx.workspaces.splice(0, ctx.workspaces.length, ...rawData
            .filter((ws: any) => {
                if (!ws || typeof ws.id !== 'string' || typeof ws.directoryPath !== 'string' || !Array.isArray(ws.runtimes)) {
                    ctx.metrics.record('session_corrupted', 'failure', { reason: 'missing_fields', raw: JSON.stringify(ws).slice(0, 200) });
                    ctx.outputChannel.appendLine(`[sessions] Removed corrupted workspace: ${JSON.stringify(ws).slice(0, 200)}`);
                    return false;
                }
                return true;
            })
            .map((ws: any) => {
                const validRuntimes = (ws.runtimes || []).filter((r: any) => {
                    if (!r || typeof r.id !== 'string' || typeof r.host !== 'string' || !validStatuses.has(r.status)) {
                        ctx.metrics.record('session_corrupted', 'failure', { reason: 'missing_fields', workspace: ws.id, raw: JSON.stringify(r).slice(0, 200) });
                        ctx.outputChannel.appendLine(`[sessions] Removed corrupted session: ${JSON.stringify(r).slice(0, 200)}`);
                        return false;
                    }
                    if (r.status !== 'Local' && !r.isLocal && (!r.wallTime || !r.queue || !r.allocation)) {
                        ctx.metrics.record('session_corrupted', 'failure', { reason: 'missing_remote_fields', workspace: ws.id, session: r.id });
                        ctx.outputChannel.appendLine(`[sessions] Removed corrupted remote session ${r.id}: missing wallTime/queue/allocation`);
                        return false;
                    }
                    return true;
                });
                return {
                    ...ws,
                    directoryName: ws.directoryPath === 'unknown' ? 'No Folder' : (ws.directoryName || path.basename(ws.directoryPath) || ws.directoryPath),
                    runtimes: validRuntimes.map((r: any) => ({
                        ...r,
                        submittedAt: new Date(r.submittedAt),
                    })),
                };
            })
            .filter((ws: any) => ws.runtimes.length > 0));
        // Save cleaned data if any corrupted entries were removed
        if (ctx.workspaces.length !== rawData.length || ctx.workspaces.some((ws: Workspace, i: number) => ws.runtimes.length !== (rawData[i]?.runtimes?.length ?? 0))) {
            saveSessions(ctx);
        }
    } else {
        ctx.workspaces.splice(0, ctx.workspaces.length);
    }

    // --- Startup Reconciliation ---
    // 1. Strip ephemeral process state (processes are dead after extension reload).
    //    Preserve sshTunnelLocalPort — the tunnel connection (managed by the linkspan)
    //    survives VS Code reloads, and Remote-SSH needs the SSH config entry to stay valid.
    for (const session of allRuntimes(ctx.workspaces)) {
        session.connectionId = undefined;
        session._portMap = undefined;
        session.syncProgress = undefined;
    }
    // 2. Clean SSH config — remove entries for terminal or nonexistent sessions
    reconcileSshConfig(ctx);
    // 3. Terminate any stale sync/mount sessions from previous extension runs
    ctx.syncProvider.cleanStaleSessions();
    ctx.mountProvider.cleanStaleMounts();
    // 4. Reset non-local sessions without SLURM job ID back to Idle
    for (const session of allRuntimes(ctx.workspaces)) {
        if (session.isLocal || session.status === 'Local') { continue; }
        if (!session.slurmJobId && session.status !== 'Idle' && session.status !== 'Failed' && session.status !== 'Completed') {
            session.status = 'Idle';
        }
    }
    // 5. Reconcile local sessions (relaunch if process died)
    for (const session of allRuntimes(ctx.workspaces)) {
        if (session.status === 'Local') { continue; }
        if (session.isLocal && session.status === 'Active' && session.localPid) {
            try {
                process.kill(session.localPid, 0);
            } catch {
                resumeLocalSession(session, ctx, refresh);
            }
        }
    }
    // 6. Infer expired sessions from walltime
    for (const session of allRuntimes(ctx.workspaces)) {
        if (session.isLocal || session.status === 'Failed' || session.status === 'Completed') { continue; }
        if (session.status === 'Active' && session.submittedAt && session.wallTime) {
            const wtParts = session.wallTime.split(':').map(Number);
            const wtTotalMin = (wtParts[0] || 0) * 60 + (wtParts[1] || 0);
            const deadlineMs = new Date(session.submittedAt).getTime() + wtTotalMin * 60000;
            if (Date.now() >= deadlineMs) {
                session.status = 'Completed';
                clearSessionFields(session);
            }
        }
    }
    // 7. Prune terminal sessions older than 24 hours
    const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let pruned = false;
    for (const ws of ctx.workspaces) {
        const before = ws.runtimes.length;
        ws.runtimes = ws.runtimes.filter(r => {
            if ((r.status === 'Completed' || r.status === 'Failed') && r.terminatedAt) {
                if (now - r.terminatedAt > TERMINAL_TTL_MS) {
                    ctx.outputChannel.appendLine(`[sessions] Pruning stale terminal session ${r.id} (terminated ${new Date(r.terminatedAt).toISOString()})`);
                    return false;
                }
            }
            return true;
        });
        if (ws.runtimes.length !== before) { pruned = true; }
    }
    if (pruned) {
        ctx.workspaces = ctx.workspaces.filter(ws => ws.runtimes.length > 0);
        saveSessions(ctx);
    }

    // Don't auto-resume polling on webview resolve — polling is only
    // started when a job is actively submitted via the UI.
}
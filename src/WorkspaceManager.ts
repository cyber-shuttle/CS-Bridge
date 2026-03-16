import * as vscode from 'vscode';
import { CSExtensionContext } from './ExtensionContext';


export interface Runtime {
    id: string;
    host: string;
    cpus: string;
    memory: string;
    gpu: string;
    wallTime: string;
    queue: string;
    allocation: string;
    status: 'Local' | 'Pending' | 'Active' | 'Submitting' | 'Deploying agent' | 'Stopping' | 'Failed' | 'Completed' | 'Idle';
    switchOnReady?: boolean;
    submittedAt: Date;
    type: 'local' | 'remote';
    // Window registration fields
    windowId?: string;        // Stable per-window identifier (persisted in globalState)
    heartbeat?: number;       // Unix timestamp of last heartbeat
    slurmJobId?: string;
    script?: string;
    errorMessage?: string;
    isLocal?: boolean;
    localPid?: number;
    tunnelUrl?: string;
    tunnelToken?: string;
    tunnelId?: string;
    sshPort?: number;
    connectedRemotePath?: string;
    localWorkspaceFolder?: string;
    localWorkdir?: string;
    computeNode?: string;
    // FUSE mount fields (still referenced in cleanup paths)
    fuseMountPid?: number;
    localMountPath?: string;
    remoteMountPath?: string;
    localFuseTunnelUrl?: string;
    remoteFusePort?: number;
    fuseTunnelPid?: number;
    localFuseServerPid?: number;
    localFuseTunnelId?: string;
    localFuseConnectToken?: string;
    localFusePort?: number;
    // Tunnel connection state (ephemeral / Tier 3 — not persisted)
    connectionId?: string;
    _portMap?: Map<number, number>; // transient: remotePort → localPort
    // SSH tunnel to compute node (for remote switch)
    sshTunnelPid?: number;
    sshTunnelLocalPort?: number;
    /** @deprecated — old devtunnel CLI connect PID */
    devtunnelConnectPid?: number;
    /** @deprecated — old devtunnel CLI port map */
    _devtunnelPortMap?: Map<number, number>;
    noSlurm?: boolean;
    // Log port from linkspan workflow
    logPort?: number;
    // Remote linkspan HTTP server port (for SSH-based API calls)
    remoteServerPort?: number;
    // Sync progress for VFS sync-back
    syncProgress?: { transferred: number; total: number };
    // Timestamp when session entered a terminal state
    terminatedAt?: number;
}

export interface Workspace {
    id: string;
    directoryPath: string;
    directoryName: string;
    runtimes: Runtime[];
}

export function findRuntime(runtimeId: string, ctx: CSExtensionContext): { workspace: Workspace; runtime: Runtime } | undefined {
    for (const ws of ctx.workspaces) {
        const rt = ws.runtimes.find(r => r.id === runtimeId);
        if (rt) { return { workspace: ws, runtime: rt }; }
    }
    return undefined;
}

export function allRuntimes(workspaces: Workspace[]): Runtime[] {
    return workspaces.flatMap(ws => ws.runtimes);
}

/**
* Detect which session (if any) is active in this VS Code window.
* Checks workspace folder URI for Remote-SSH patterns:
*   - Local sessions: ssh-remote+cs-tunnel-{id}
*   - Remote SLURM sessions: ssh-remote+{hostName}
*/
export function detectActiveSession(workspaces: Workspace[], windowId: string): Runtime | undefined {
    // First, try to match by vscode-remote URI (more reliable than windowId for remote windows)
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.uri.scheme === 'vscode-remote') {
        const authority = folder.uri.authority;
        const allRuntimesList = allRuntimes(workspaces);
        // Local session: ssh-remote+cs-tunnel-{sessionId}
        const localMatch = authority.match(/^ssh-remote\+cs-tunnel-(.+)$/);
        if (localMatch) {
            const sessionId = localMatch[1];
            return allRuntimesList.find(s => s.id === sessionId);
        }
        // Remote SLURM session: ssh-remote+cs-session-{sessionId}
        const remoteMatch = authority.match(/^ssh-remote\+cs-session-(.+)$/);
        if (remoteMatch) {
            const sessionId = remoteMatch[1];
            return allRuntimesList.find(s => s.id === sessionId);
        }
        // Fallback: match by hostname for remote sessions
        const hostMatch = authority.match(/^ssh-remote\+(.+)$/);
        if (hostMatch) {
            const hostName = hostMatch[1];
            return allRuntimesList.find(s => !s.isLocal && s.host === hostName && s.status === 'Active')
                || allRuntimesList.find(s => !s.isLocal && s.host === hostName);
        }
    }

    // Fallback: check if this window has its own registered runtime
    const allRuntimesList = allRuntimes(workspaces);
    const mySession = allRuntimesList.find(s => s.windowId === windowId);
    return mySession;
}

/**
* Determine which workspaces to show in the sidebar.
* For local windows: match by folder path.
* For remote windows: find the workspace containing the active session so that
* session info remains visible after switching to remote.
*/
export function getVisibleWorkspaces(workspaces: Workspace[], activeSession: Runtime | undefined): Workspace[] {
    const currentFolder = vscode.workspace.workspaceFolders?.[0];

    // For remote windows, find the workspace containing the active session
    if (currentFolder?.uri.scheme === 'vscode-remote' && activeSession) {
        const ws = workspaces.find(w => w.runtimes.some(r => r.id === activeSession.id));
        return ws ? [ws] : [];
    }

    const currentDirPath = currentFolder
        ? (currentFolder.uri.scheme === 'file' ? currentFolder.uri.fsPath : currentFolder.uri.toString())
        : undefined;
    return currentDirPath
        ? workspaces.filter(ws => ws.directoryPath === currentDirPath)
        : [];
}
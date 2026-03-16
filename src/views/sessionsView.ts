import * as vscode from 'vscode';
import { escapeHtml, getCommonStyles, getNonce } from '../utils';
import { getSshHosts } from '../SshManager';
import { detectActiveSession, getVisibleWorkspaces, Runtime, Workspace } from '../WorkspaceManager';
import * as os from 'os';

/**
     * Generate the HTML for the SESSIONS webview.
     * Contains: workspace cards (sessions + host picker), script preview overlay.
     */
export function getSessionsHtml(webview: vscode.Webview, extensionUri: vscode.Uri,
    workspaces: Workspace[], windowId: string): string {
    // Use a nonce to only allow a specific script to run
    const nonce = getNonce();

    const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.ttf'));
    const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.css'));
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'common.css'));
    const sessionsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'sessions', 'sessions.css'));
    const sessionsJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'sessions', 'sessions.js'));

    // Get SSH hosts from config — used for the workspace host picker
    const sshHosts = getSshHosts();

    // Build sessions HTML — workspace-grouped cards
    const activeSession = detectActiveSession(workspaces, windowId);



    // Helper: build runtime row HTML — renders an invisible placeholder card.
    // Real data is populated when the JS signals 'webviewReady' and receives updateRuntimes.
    // Cards are hidden until populated; a panel-level spinner shows in the meantime.
    const buildRuntimeRow = (rt: Runtime, _wsPath?: string): string => {
        const isLocal = !!rt.isLocal;
        const displayName = isLocal ? 'Local' : escapeHtml(rt.host);
        return `
                <div class="runtime-entry status-idle" data-session-id="${escapeHtml(rt.id)}" style="display:none;">
                    <div class="runtime-header">
                        <span class="runtime-name">${displayName}</span>
                        <div class="runtime-header-right"></div>
                        <span class="dot-action-wrap"><span class="status-dot dot-idle"></span></span>
                    </div>
                    <div class="runtime-details"></div>
                </div>`;
    };

    // Helper: build the host picker HTML for a workspace
    const buildHostPickerHtml = (ws: Workspace): string => {
        if (sshHosts.length === 0) {
            return '<p class="empty-message" style="margin:8px;">No SSH hosts found in ~/.ssh/config</p>';
        }
        return sshHosts.map(host => `
                <div class="host-picker-item">
                    <div class="host-picker-row" data-host="${escapeHtml(host.name)}" data-workspace-id="${escapeHtml(ws.id)}" title="${host.hostname ? escapeHtml((host.user ? host.user + '@' : '') + host.hostname) : escapeHtml(host.name)}">
                        <span class="host-picker-chevron">&#x203A;</span>
                        <span class="host-picker-name">${escapeHtml(host.name)}</span>
                        ${host.hostname ? `<span class="host-picker-detail">${host.user ? escapeHtml(host.user) + '@' : ''}${escapeHtml(host.hostname)}</span>` : ''}
                    </div>
                    <div class="host-picker-form" id="host-form-${escapeHtml(ws.id)}-${escapeHtml(host.name)}" style="display:none;">
                        <div class="job-form-loading" style="display:none;"><span class="spinner"></span>Fetching partitions...</div>
                        <div class="job-form-error" style="display:none;"><span class="job-form-error-text"></span></div>
                        <div class="job-form-fields" style="display:none;">
                            <div class="resource-tabs" data-host="${escapeHtml(host.name)}">
                                <button class="resource-tab active" data-tab="cpu" data-host="${escapeHtml(host.name)}">CPU</button>
                                <button class="resource-tab" data-tab="gpu" data-host="${escapeHtml(host.name)}" style="display:none;">GPU</button>
                            </div>
                            <div class="form-row alloc-row" data-host="${escapeHtml(host.name)}"><label>Allocation</label><select class="form-select" data-field="allocation" data-host="${escapeHtml(host.name)}">
                                <option value="">Loading...</option>
                            </select></div>
                            <div class="form-row"><label>Partition</label><select class="form-select" data-field="queue" data-host="${escapeHtml(host.name)}">
                                <option value="">Select allocation first</option>
                            </select></div>
                            <div class="form-row"><label>CPUs</label><select class="form-select" data-field="cpus">
                                <option value="1">1</option><option value="2">2</option><option value="4">4</option>
                                <option value="8">8</option><option value="16">16</option><option value="32">32</option><option value="64">64</option>
                            </select></div>
                            <div class="form-row"><label>Memory</label><select class="form-select" data-field="memory">
                                <option value="1 GB">1 GB</option><option value="2 GB">2 GB</option><option value="4 GB">4 GB</option>
                                <option value="8 GB">8 GB</option><option value="16 GB">16 GB</option><option value="32 GB">32 GB</option>
                                <option value="64 GB">64 GB</option><option value="128 GB">128 GB</option>
                            </select></div>
                            <div class="form-row gpu-count-row" style="display:none" data-host="${escapeHtml(host.name)}"><label>GPUs</label><select class="form-select" data-field="gpuCount" data-host="${escapeHtml(host.name)}">
                                <option value="0">None</option>
                            </select></div>
                            <div class="form-row gpu-type-row" style="display:none" data-host="${escapeHtml(host.name)}"><label>GPU Type</label><select class="form-select" data-field="gpuType" data-host="${escapeHtml(host.name)}">
                            </select></div>
                            <div class="form-row"><label>Wall Time</label><select class="form-select" data-field="wallTime">
                                <option value="00:30:00">30 min</option><option value="01:00:00">1 hour</option>
                                <option value="02:00:00">2 hours</option><option value="04:00:00">4 hours</option>
                                <option value="08:00:00">8 hours</option><option value="12:00:00">12 hours</option>
                                <option value="24:00:00">24 hours</option>
                            </select></div>
                            <button class="submit-job-btn" data-host="${escapeHtml(host.name)}" data-workspace-id="${escapeHtml(ws.id)}">Add</button>
                        </div>
                    </div>
                </div>
            `).join('');
    };

    // Only show the workspace matching the currently open folder
    const visibleWorkspaces = getVisibleWorkspaces(workspaces, activeSession);

    // Build sessions HTML
    const sessionsHtml = visibleWorkspaces.length > 0
        ? visibleWorkspaces.map(ws => {
            const sortedRuntimes = [...ws.runtimes].sort((a, b) => {
                if (a.windowId === windowId) { return -1; }
                if (b.windowId === windowId) { return 1; }
                const statusOrder: Record<string, number> = { Local: 0, Active: 1, Submitting: 2, Pending: 3, Idle: 4, Failed: 5, Completed: 6 };
                const sa = statusOrder[a.status] ?? 99;
                const sb = statusOrder[b.status] ?? 99;
                if (sa !== sb) { return sa - sb; }
                return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
            });
            // Split runtimes into active (this window) vs others
            // When activeSession is detected, only that session is "active"; everything else is "other".
            // When no activeSession (e.g. fresh local window), fall back to putting the local session in active.
            const activeRuntimes = activeSession
                ? sortedRuntimes.filter(rt => rt.id === activeSession.id)
                : sortedRuntimes.filter(rt => rt.isLocal);
            const otherRuntimes = activeSession
                ? sortedRuntimes.filter(rt => rt.id !== activeSession.id)
                : sortedRuntimes.filter(rt => !rt.isLocal);
            const activeRows = activeRuntimes.map(rt => buildRuntimeRow(rt, ws.directoryPath)).join('');
            const otherRows = otherRuntimes.map(rt => buildRuntimeRow(rt, ws.directoryPath)).join('');
            const hostPickerHtml = buildHostPickerHtml(ws);
            const displayPath = ws.directoryPath.startsWith(os.homedir())
                ? '~' + ws.directoryPath.slice(os.homedir().length)
                : ws.directoryPath;
            const activeSection = activeRows ? `<div class="session-group"><div class="session-group-label">Active Session</div><div class="workspace-runtimes">${activeRows}</div></div>` : '';
            const otherSection = otherRows ? `<div class="session-group"><div class="session-group-label">Other Sessions</div><div class="workspace-runtimes">${otherRows}</div></div>` : '';
            return `
                <div class="workspace-section" data-workspace-id="${escapeHtml(ws.id)}" style="display:none;">
                    ${activeSection}
                    ${otherSection}
                    <div class="add-session-placeholder" data-workspace-id="${escapeHtml(ws.id)}">
                        <i class="codicon codicon-add"></i> Add Session
                    </div>
                    <div class="workspace-host-picker" id="host-picker-${escapeHtml(ws.id)}" style="display:none;">
                        ${hostPickerHtml}
                    </div>
                </div>`;
        }).join('')
        : vscode.workspace.workspaceFolders?.[0]
            ? '<p class="empty-message">No active sessions</p>'
            : '<p class="empty-message">Open a folder to get started</p>';


    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Sessions</title>
    <link rel="stylesheet" href="${codiconsCssUri}">
    <link rel="stylesheet" href="${commonCssUri}">
    <link rel="stylesheet" href="${sessionsCssUri}">
    <style>
        ${getCommonStyles(codiconsFontUri)}
    </style>
</head>
<body>
    ${visibleWorkspaces.length > 0 ? '<div id="sessions-loading" class="panel-loading"><span class="spinner"></span></div>' : ''}
    <div id="sessions">
        ${sessionsHtml}
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

    <script nonce="${nonce}" src="${sessionsJsUri}"></script>
</body>
</html>`;
}
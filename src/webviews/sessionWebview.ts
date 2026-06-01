import * as vscode from 'vscode';
import type { AccountInfo, SlurmSession, SshHost } from '../models';

export type UiState = { pickerOpen: boolean; openHosts: string[] };

function ci(name: string) { return '<i class="codicon codicon-' + name + '"></i>'; }

const buildHostPickerHtml = (sshHosts: SshHost[], openHosts: string[]): string => {
    if (sshHosts.length === 0) {
        return '<p class="empty-message" style="margin:8px;">No SSH hosts yet — add one above.</p>';
    }
    const openSet = new Set(openHosts);
    return sshHosts.map(host => {
        const open = openSet.has(host.name);
        return `
        <div class="host-picker-item">
            <div class="host-picker-row" data-host="${escapeHtml(host.name)}"  title="${host.hostname ? escapeHtml((host.user ? host.user + '@' : '') + host.hostname) : escapeHtml(host.name)}">
                <span class="host-picker-chevron${open ? ' expanded' : ''}">&#x203A;</span>
                <span class="host-picker-name">${escapeHtml(host.name)}</span>
                ${host.managed ? '<span class="host-managed-badge" title="Managed by CS Bridge">CS</span>' : ''}
                ${host.hostname ? `<span class="host-picker-detail">${host.user ? escapeHtml(host.user) + '@' : ''}${escapeHtml(host.hostname)}</span>` : ''}
                ${host.managed ? `<button class="host-delete-btn" data-host="${escapeHtml(host.name)}" title="Remove SSH host">${ci('trash')}</button>` : ''}
            </div>
            <div class="host-picker-form" id="host-form-${escapeHtml(host.name)}" style="display:${open ? 'block' : 'none'};">
                <div class="job-form-loading" style="display:${open ? 'flex' : 'none'};"><span class="spinner"></span>Fetching runtime details...</div>
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
                    <button class="submit-job-btn" data-host="${escapeHtml(host.name)}">Add</button>
                </div>
            </div>
        </div>
        `;
    }).join('');
};

function generateSessionDetailsHtml(session: SlurmSession): string {

    // The wall-time badge is rendered client-side by sessions.js on the first update.
    const timePart = '<span class="session-countdown-badge"></span>';

    const gpuPart = session.gpuClass !== 'None' ? ' <span class="detail-sep">|</span> ' + ci('circuit-board') + ' ' + escapeHtml(session.gpuClass) : '';

    const line1 = ci('account') + ' ' + escapeHtml(session.allocation) +
        ' <span class="detail-sep">|</span> ' + ci('server-environment') + ' ' + escapeHtml(session.queue) +
        ' <span class="detail-sep">|</span> ' + ci('vm') + ' ' + session.cpus +
        ' <span class="detail-sep">|</span> ' + ci('database') + ' ' + session.memory + gpuPart +
        ' <span class="detail-sep">|</span> ' + timePart;

    const line2 = '<span class="session-detail">' + ci('cloud') + ' ' + escapeHtml(session.connectionInfo ? session.connectionInfo.apiTunnelId : '') +
        ' <button class="copy-btn" data-copy="' + escapeHtml(session.connectionInfo ? session.connectionInfo.apiTunnelId : '') + '" title="Copy tunnel ID">' + ci('copy') + '</button></span>';

    const incActionBtns = [];
    incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + session.id + '">' + ci('debug-stop') + ' Stop</button>');
    incActionBtns.push('<button class="session-action-main action-switch switch-btn session-btn-switch-here" data-session-id="' + session.id + '" data-direction="remote"' + '>' + ci('arrow-swap') + ' Connect</button>');


    const statusLeft = line2 || '';
    const btnsRight = incActionBtns.length > 0 ? '<span class="session-action-btns">' + incActionBtns.join('') + '</span>' : '';
    const actionRowHtml = (statusLeft || btnsRight) ? '<div class="session-action-row">' + statusLeft + btnsRight + '</div>' : '';
    const detailInner = '<span class="session-detail">' + line1 + '</span>' + actionRowHtml;

    return detailInner;
}


function generateSessionCardHtml(session: SlurmSession): string {
    return `
    <div class="runtime-entry status-idle" data-session-id="${escapeHtml(session.id)}">
        <div class="runtime-header">
            <span class="runtime-name">${escapeHtml(session.name)}</span>
            <div class="runtime-header-right"></div>
            <span class="dot-action-wrap"><span class="status-dot dot-idle"></span></span>
        </div>
        <div class="runtime-details">${generateSessionDetailsHtml(session)}</div>
    </div>
    `;
}

function generateSessionsHtml(sessions: SlurmSession[], sshHosts: SshHost[], uiState: UiState): string {

    const sessionsHtml = sessions.map(generateSessionCardHtml).join('');
    const sessionsWrapperHtml = sessions.length > 0 ?
        `<div class="session-group">
            <div class="session-group-label">Sessions</div>
            <div class="workspace-runtimes">${sessionsHtml}</div>
        </div>` : '';

    return `
    <div class="workspace-section">
        ${sessionsWrapperHtml}
        <div class="add-session-placeholder">
            <i class="codicon codicon-add"></i> Add Session
        </div>
        <div class="workspace-host-picker" id="host-picker" style="display:${uiState.pickerOpen ? 'block' : 'none'};">
            <div class="add-ssh-host-row" title="Add a new SSH host">
                <i class="codicon codicon-add"></i> Add SSH Host
            </div>
            ${buildHostPickerHtml(sshHosts, uiState.openHosts)}
        </div>
    </div>`;
}

export function getSessionWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    sessions: SlurmSession[],
    account: AccountInfo,
    sshHosts: SshHost[],
    uiState: UiState,
    previewSession: SlurmSession | null,
): string {

    const nonce = getNonce();
    const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'codicons', 'codicon.ttf'));
    const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'codicons', 'codicon.css'));
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'common.css'));
    const sessionsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'sessions.css'));
    const infoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'info.css'));
    const sessionsJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'js', 'sessions.js'));

    const valueClass = account.label ? 'info-value' : 'info-value info-value-warn';
    const valueText = account.label ? escapeHtml(account.label) : 'Not signed in';
    const buttonText = account.label ? 'Switch' : 'Sign in';

    return `
    <!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>CS Bridge Sessions</title>
            <link rel="stylesheet" href="${codiconsCssUri}">
            <link rel="stylesheet" href="${commonCssUri}">
            <link rel="stylesheet" href="${sessionsCssUri}">
            <link rel="stylesheet" href="${infoCssUri}">
            <style>@font-face { font-family: "codicon"; font-display: block; src: url("${codiconsFontUri}") format("truetype"); }</style>
        </head>
        <body>
            <div id="auth">
                <div id="account-line" class="info-line">
                    <span class="info-label">${escapeHtml(account.type)} Account:</span>
                    <span id="account-value" class="${valueClass}">${valueText}</span>
                    <button id="auth-switch-btn" class="info-action-btn">${buttonText}</button>
                </div>
            </div>
            <div id="sessions">
                ${generateSessionsHtml(sessions, sshHosts, uiState)}
            </div>

            <div id="script-preview-overlay" preview-session-id="${previewSession ? escapeHtml(previewSession.id) : ''}" class="script-preview-overlay${previewSession ? ' visible' : ''}">
                <div class="script-preview-header">SLURM Job Script Preview</div>
                <div id="script-preview-host" class="script-preview-host">${previewSession ? `Host: ${escapeHtml(previewSession.cluster)}` : ''}</div>
                <div id="script-preview-code" class="script-preview-code">${previewSession ? escapeHtml(previewSession.batchScript ?? '') : ''}</div>
                <div class="script-preview-actions">
                    <button id="cancel-preview-btn" class="cancel-preview-btn">Cancel</button>
                    <button id="confirm-preview-btn">Submit Job</button>
                </div>
            </div>

            <script nonce="${nonce}" src="${sessionsJsUri}"></script>
        </body>
    </html>`;
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

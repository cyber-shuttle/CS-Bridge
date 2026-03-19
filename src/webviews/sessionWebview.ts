import * as vscode from 'vscode';
import { Session, SlurmSession } from '../models';
import { Logger } from '../logger';

function ci(name: string) { return '<i class="codicon codicon-' + name + '"></i>'; }

function generateSessionDetailsHtml(session: SlurmSession): string {

    const deadMs = 2000;
    const totalMs = 5000;
    const _remStr = Math.ceil(deadMs / 1000) + 's';
    const _reqStr = Math.ceil(totalMs / 1000) + 's';
    const _initText = ci('watch') + ' ' + _remStr + ' / ' + _reqStr;
    const timePart = '<span class="session-countdown-badge" data-deadline="' + deadMs + '" data-total="' + totalMs + '">' + _initText + '</span>';
    const rem = Math.max(0, deadMs - Date.now());
    const pct = totalMs > 0 ? (rem / totalMs) * 100 : 0;
    const progressHtml = '<div class="session-progress-bar"><div class="session-progress-fill" data-deadline="' + deadMs + '" data-total="' + totalMs + '" style="width:' + pct.toFixed(1) + '%"></div></div>';

    const gpuPart = session.gpuClass !== 'None' ? ' <span class="detail-sep">|</span> ' + ci('circuit-board') + ' ' + escapeHtml(session.gpuClass) : '';

    const line1 = ci('server-environment') + ' ' + escapeHtml(session.queue) +
        ' <span class="detail-sep">|</span> ' + ci('account') + ' ' + escapeHtml(session.allocation) +
        ' <span class="detail-sep">|</span> ' + ci('vm') + ' ' + session.cpus +
        ' <span class="detail-sep">|</span> ' + ci('database') + ' ' + session.memory + gpuPart +
        ' <span class="detail-sep">|</span> ' + timePart;

    const line2 = '<span class="session-detail">' + ci('cloud') + ' ' + escapeHtml(session.tunnelId || '') +
        ' <button class="copy-btn" data-copy="' + escapeHtml(session.tunnelUrl) + '" title="Copy tunnel URL">' + ci('copy') + '</button></span>';

    const incActionBtns = [];
    incActionBtns.push('<button class="session-action-main action-stop stop-btn" data-session-id="' + session.id + '">' + ci('debug-stop') + ' Stop</button>');
    incActionBtns.push('<button class="session-action-main action-switch switch-btn session-btn-switch-here" data-session-id="' + session.id + '" data-direction="remote"' + '>' + ci('arrow-swap') + ' Activate</button>');


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

function generateSessionsHtml(sessions: SlurmSession[]): string {

    const sessionsHtml = sessions.map(generateSessionCardHtml).join('');
    const sessionsWrapperHtml = sessions.length > 0 ?
        `<div class="session-group">
            <div class="session-group-label">Other Sessions</div>
            <div class="workspace-runtimes">${sessionsHtml}</div>
        </div>` : '';

    return `
    <div class="workspace-section">
        ${sessionsWrapperHtml}
        <div class="add-session-placeholder">
            <i class="codicon codicon-add"></i> Add Session
        </div>
    </div>`;
}

export function getSessionWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, sessions: SlurmSession[]): string {

    const logger = Logger.getInstance();
    const nonce = getNonce();
    const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.ttf'));
    const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.css'));
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'common.css'));
    const sessionsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'sessions.css'));
    const sessionsJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'js', 'sessions.js'));

    const sessionsHtml = generateSessionsHtml(sessions);
    logger.debug('Generated session html :', sessionsHtml);

    return `
    <!DOCTYPE html>
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
            <!-- ${sessions.length > 0 ? '<div id="sessions-loading" class="panel-loading"><span class="spinner"></span></div>' : ''} -->
            <div id="sessions">
                ${sessionsHtml}
            </div>

            <script nonce="${nonce}" src="${sessionsJsUri}"></script>
        </body>
    </html>`;
}

export function getCommonStyles(codiconsFontUri: vscode.Uri): string {
    return `
        @font-face {
            font-family: "codicon";
            font-display: block;
            src: url("${codiconsFontUri}") format("truetype");
        }
        `;
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
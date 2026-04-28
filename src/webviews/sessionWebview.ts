import * as vscode from 'vscode';
import { Session, SlurmSession } from '../models';
import { Logger } from '../logger';

function ci(name: string) { return '<i class="codicon codicon-' + name + '"></i>'; }


function generateSessionCardHtml(session: SlurmSession): string {
    return `
    <div class="runtime-entry status-idle" data-session-id="${escapeHtml(session.id)}">
        <div class="runtime-header">
            <span class="runtime-name">${escapeHtml(session.name)}</span>
            <div class="runtime-header-right"></div>
            <span class="dot-action-wrap"><span class="status-dot dot-idle"></span></span>
        </div>
        <div class="runtime-details"></div>
    </div>
    `;
}

// Session list HTML generation and Host picker HTML generation
function generateSessionsHtml(sessions: SlurmSession[]): string {

    const sessionsHtml = sessions.map(generateSessionCardHtml).join('');
    const sessionsHeaderHtml = `<div class="session-group-header">
            <div class="session-group-label">Sessions</div>
            <button id="sessions-refresh-btn" class="info-action-btn" title="Refresh sessions">${ci('refresh')} Refresh</button>
        </div>`;
    const sessionsWrapperHtml = `<div class="session-group">
            ${sessionsHeaderHtml}
            ${sessions.length > 0 ? `<div class="workspace-runtimes">${sessionsHtml}</div>` : '<p class="empty-message" style="margin:8px 0;">No sessions yet</p>'}
        </div>`;

    return `
    <div class="workspace-section">
        ${sessionsWrapperHtml}
        <div class="add-session-placeholder">
            <i class="codicon codicon-add"></i> Add Session
        </div>
        <div class="workspace-host-picker" id="host-picker" style="display:none;"></div>
    </div>`;
}

export function getSessionWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, sessions: SlurmSession[]): string {

    const logger = Logger.getInstance();
    const nonce = getNonce();
    const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.ttf'));
    const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.css'));
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'common.css'));
    const sessionsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'sessions.css'));
    const infoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'css', 'info.css'));

    const sessionsJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webviews', 'js', 'sessions.js'));

    const sessionsHtml = generateSessionsHtml(sessions);
    const authHtml = `
    <div id="account-line" class="info-line">
        <span class="info-label">Microsoft Account:</span>
        <span id="account-value" class="info-value 'info-value-warn'}">Dimuthu</span>
        <button id="auth-switch-btn" class="info-action-btn">Switch</button>
    </div>
    `;

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
            <link rel="stylesheet" href="${infoCssUri}">
            <style>
                ${getCommonStyles(codiconsFontUri)}
            </style>
        </head>
        <body>
            <!-- ${sessions.length > 0 ? '<div id="sessions-loading" class="panel-loading"><span class="spinner"></span></div>' : ''} -->
            <div id="auth">
                ${authHtml}
            </div>
            <div id="sessions">
                ${sessionsHtml}
            </div>

            <!-- Script preview overlay -->
            <div id="script-preview-overlay" preview-session-id="" class="script-preview-overlay">
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
import * as vscode from 'vscode';
import { Session } from '../models';
import { Logger } from '../logger';

function generateSessionCardHtml(session: Session): string {
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

function generateSessionsHtml(sessions: Session[]): string {

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

export function getSessionWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, sessions: Session[]): string {

    const logger = Logger.getInstance();
    const nonce = getNonce();
    const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.ttf'));
    const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.css'));
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webviews', 'css', 'common.css'));
    const sessionsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webviews', 'css', 'sessions.css'));
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
            ${sessions.length > 0 ? '<div id="sessions-loading" class="panel-loading"><span class="spinner"></span></div>' : ''}
            <div id="sessions">
                ${sessionsHtml}
            </div>
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
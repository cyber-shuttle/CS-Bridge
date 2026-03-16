import * as vscode from 'vscode';
import { escapeHtml, getCommonStyles, getNonce } from '../utils';
import { getSshHosts } from '../SshManager';
import { StorageBrowserManager } from '../StorageBrowserManager';

/**
     * Generate the HTML for the FILES webview.
     * Contains: SSH host list as file tree roots, with directory browsing and file opening.
     */
export function getStoragesHtml(webview: vscode.Webview, extensionUri: vscode.Uri, storageBrowser: StorageBrowserManager): string {
    const nonce = getNonce();
    const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.ttf'));
    const codiconsCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicons', 'codicon.css'));
    const commonCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'common.css'));
    const storagesCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'storages', 'storages.css'));

    const storagesJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'webview-ui', 'storages', 'storages.js'));

    const sshHosts = getSshHosts();
    const browseHost = storageBrowser.browseHost;

    // Build breadcrumbs and determine view state
    let breadcrumbsHtml: string;
    let bodyHtml: string;

    if (browseHost) {
        // Browsing inside a host — show breadcrumbs: home / host-name / path / ...
        const current = storageBrowser.browseHistory[storageBrowser.browseCursor];
        const currentPath = current?.path || '~';
        const segments = currentPath.split('/').filter(Boolean);

        const crumbs = [
            `<span class="breadcrumb-seg breadcrumb-home" data-action="home" title="All hosts"><i class="codicon codicon-home"></i></span>`,
            `<span class="breadcrumb-sep">/</span>`,
            `<span class="breadcrumb-seg breadcrumb-host" data-action="host-root" title="${escapeHtml(browseHost)}">${escapeHtml(browseHost)}</span>`,
        ];
        for (let i = 0; i < segments.length; i++) {
            const segPath = '/' + segments.slice(0, i + 1).join('/');
            crumbs.push(
                `<span class="breadcrumb-sep">/</span>`,
                `<span class="breadcrumb-seg" data-path="${escapeHtml(segPath)}">${escapeHtml(segments[i])}</span>`
            );
        }
        breadcrumbsHtml = crumbs.join('');

        bodyHtml = `
                <div class="file-list" id="storages-list">
                    <div class="file-status" id="storages-status"></div>
                </div>`;
    } else {
        // Root view — show SSH hosts as folder entries (like VS Code tunnels list)
        breadcrumbsHtml = `<span class="breadcrumb-seg breadcrumb-home breadcrumb-current" data-action="home"><i class="codicon codicon-home"></i></span><span class="breadcrumb-sep">/</span>`;

        if (sshHosts.length > 0) {
            const entriesHtml = sshHosts.map(host => {
                const detail = host.hostname
                    ? `${host.user ? escapeHtml(host.user) + '@' : ''}${escapeHtml(host.hostname)}`
                    : '';
                return `<div class="file-entry dir" data-host="${escapeHtml(host.name)}">
                        <i class="codicon codicon-server"></i>
                        <span class="file-name">${escapeHtml(host.name)}</span>
                        ${detail ? `<span class="file-size">${detail}</span>` : ''}
                    </div>`;
            }).join('');
            bodyHtml = `<div class="file-list" id="storages-host-list">${entriesHtml}</div>`;
        } else {
            bodyHtml = `<div class="file-list"><p class="empty-message">No SSH hosts found in ~/.ssh/config</p></div>`;
        }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CyberShuttle Files</title>
    <link rel="stylesheet" href="${codiconsCssUri}">
    <link rel="stylesheet" href="${commonCssUri}">
    <link rel="stylesheet" href="${storagesCssUri}">
    <style>
        ${getCommonStyles(codiconsFontUri)}
    </style>
</head>
<body data-browse-host="${browseHost ? escapeHtml(browseHost) : ''}">
    <div class="file-breadcrumbs">${breadcrumbsHtml}</div>
    ${bodyHtml}

    <script nonce="${nonce}" src="${storagesJsUri}"></script>
</body>
</html>`;
}
import * as vscode from 'vscode';

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, view: 'sessions' | 'hosts' | 'stats'): string {
    const nonce = getNonce();
    const codiconCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'codicons', 'codicon.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', `${view}.js`));

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" id="vscode-codicon-stylesheet" href="${codiconCss}" nonce="${nonce}">
        <!-- vscode-button height is locked by a shadow-DOM line-height; ::part(base) is the only way to make it fit the compact card rows. -->
        <style nonce="${nonce}">vscode-button::part(base){line-height:16px;}</style>
    </head>
    <body style="margin:0;padding:0"><div id="root"></div>
    <script nonce="${nonce}" src="${js}"></script>
    </body>
    </html>`;
}

export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
    return text;
}

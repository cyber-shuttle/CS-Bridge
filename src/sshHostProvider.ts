import * as vscode from 'vscode';
import { Logger } from './logger';
import { HostsState } from './models';
import { getWebviewContent } from './webviewContent';
import { SshManager } from './modules/sshSupport';
import { sshCommandToConfig, assertValidHost, SshConfigEntry } from './modules/sshCommandParser';
import { USER_SSH_CONFIG_PATH, addHostToConfigFile, removeHostFromConfigFile } from './modules/sshHostsStore';

const errMsg = (e: unknown): string => e instanceof Error ? e.message : String(e);

// Webview provider for the SSH Hosts view. Independent of sessions: it reads ~/.ssh/config + the
// read-only system SSH config via SshManager and writes user hosts to ~/.ssh/config. The post-add
// "Connect" action hands off to the Sessions view through the csbridge.newSessionOnHost command.
export class SshHostProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'csbridge.hostsView';

    private readonly _logger = Logger.getInstance();
    private _webview?: vscode.Webview;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        const webview = webviewView.webview;
        webview.options = { enableScripts: true };
        this._webview = webview;
        const msgSub = webview.onDidReceiveMessage(data => this._onMessage(data));
        const visSub = webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this._push(); } });
        webviewView.onDidDispose(() => {
            if (this._webview === webview) { this._webview = undefined; }
            msgSub.dispose();
            visSub.dispose();
        });
        webview.html = getWebviewContent(webview, this._extensionUri, 'hosts');
    }

    private _onMessage(data: any): void {
        switch (data.command) {
            case 'ready': this._push(); break;
            case 'removeSshHost': void this._removeSshHost(data.name); break;
            default: this._logger.warn('Unknown command from hosts webview:', data);
        }
    }

    // Re-read the SSH host configs and push the view's state.
    private _push(): void {
        if (!this._webview) { return; }
        const state: HostsState = { sshHosts: SshManager.getInstance().getMergedHosts() };
        this._webview.postMessage({ command: 'state', state });
    }

    // "Refresh SSH Hosts" title action — re-reads ~/.ssh/config + system config so hosts added externally
    // (e.g. via the Remote-SSH "Add New SSH Host" flow) show up without reloading the window.
    public refreshSshHosts(): void {
        this._push();
    }

    // Native "Add SSH Host" title action — Remote-SSH-parity flow: prompt -> parse/validate -> write to ~/.ssh/config -> notify.
    public async addSshHost(): Promise<void> {
        const command = (await vscode.window.showInputBox({
            title: 'Enter SSH Connection Command',
            placeHolder: 'E.g. ssh hello@microsoft.com -A',
            ignoreFocusOut: true,
        }))?.trim();
        if (!command) { return; }

        let entry: SshConfigEntry;
        try {
            entry = sshCommandToConfig(command);
            assertValidHost(entry);
        } catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            return;
        }

        try {
            addHostToConfigFile(USER_SSH_CONFIG_PATH, entry);
        } catch (err) {
            this._logger.error(`Failed to write SSH host to ${USER_SSH_CONFIG_PATH}:`, err);
            vscode.window.showErrorMessage(`Failed to save SSH host: ${errMsg(err)}`);
            return;
        }
        this._push();

        const choice = await vscode.window.showInformationMessage('Host added!', 'Open Config', 'Connect');
        if (choice === 'Open Config') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(USER_SSH_CONFIG_PATH));
        } else if (choice === 'Connect') {
            // Hand off to the Sessions view to start a new-session draft on the freshly added host.
            void vscode.commands.executeCommand('csbridge.newSessionOnHost', entry.Host);
        }
    }

    private async _removeSshHost(name: string): Promise<void> {
        // Delete controls render only on user-config rows (system is read-only), so the target is always ~/.ssh/config.
        const choice = await vscode.window.showWarningMessage(
            `Remove SSH host '${name}'?`,
            { modal: true, detail: 'This removes the Host entry from ~/.ssh/config.' },
            'Remove'
        );
        if (choice !== 'Remove') { return; }
        try {
            removeHostFromConfigFile(USER_SSH_CONFIG_PATH, name);
        } catch (err) {
            this._logger.error(`Failed to remove SSH host ${name} from ~/.ssh/config:`, err);
            vscode.window.showErrorMessage(`Failed to remove SSH host: ${errMsg(err)}`);
        }
        this._push();
    }
}

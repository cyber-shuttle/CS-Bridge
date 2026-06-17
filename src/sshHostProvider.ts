import * as vscode from 'vscode';
import { HostsState, WebviewMessage } from './models';
import { WebviewProvider } from './webviewProvider';
import { errMsg } from './logger';
import { SshManager } from './modules/sshSupport';
import { sshCommandToConfig, assertValidHost, SshConfigEntry } from './modules/sshCommandParser';
import { USER_SSH_CONFIG_PATH, addHostToConfigFile, removeHostFromConfigFile } from './modules/sshHostsStore';

// Webview provider for the SSH Hosts view: reads user + read-only system SSH config, writes user hosts to ~/.ssh/config.
export class SshHostProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.hostsView';
    protected readonly viewKind = 'hosts' as const;

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case 'ready': this.pushState(); break;
            case 'removeSshHost': void this.removeSshHost(data.name ?? ''); break;
            default: this.logger.warn('Unknown command from hosts webview:', data);
        }
    }

    protected pushState(): void {
        if (!this.view) { return; }
        const state: HostsState = { sshHosts: SshManager.getInstance().getMergedHosts() };
        this.view.webview.postMessage({ command: 'state', state });
    }

    // Title-bar action: re-read so hosts added externally (e.g. via Remote-SSH) appear without a window reload.
    public refreshSshHosts(): void {
        this.pushState();
    }

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
        }
        catch (err) {
            vscode.window.showErrorMessage(errMsg(err));
            return;
        }

        try {
            addHostToConfigFile(USER_SSH_CONFIG_PATH, entry);
        }
        catch (err) {
            this.showError('Failed to save SSH host', err);
            return;
        }
        this.pushState();

        const choice = await vscode.window.showInformationMessage('Host added!', 'Open Config', 'Connect');
        if (choice === 'Open Config') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(USER_SSH_CONFIG_PATH));
        }
        else if (choice === 'Connect') {
            void vscode.commands.executeCommand('csbridge.newSessionOnHost', entry.Host);
        }
    }

    private async removeSshHost(name: string): Promise<void> {
        // Delete controls render only on user-config rows (system is read-only), so the target is always ~/.ssh/config.
        const choice = await vscode.window.showWarningMessage(
            `Remove SSH host '${name}'?`,
            { modal: true, detail: 'This removes the Host entry from ~/.ssh/config.' },
            'Remove',
        );
        if (choice !== 'Remove') { return; }
        try {
            removeHostFromConfigFile(USER_SSH_CONFIG_PATH, name);
        }
        catch (err) {
            this.showError(`Failed to remove SSH host ${name}`, err);
        }
        this.pushState();
    }
}

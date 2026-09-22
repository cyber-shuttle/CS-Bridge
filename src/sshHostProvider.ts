import * as vscode from 'vscode';
import { HostsState, WebviewMessage } from './models';
import { readFile } from 'node:fs/promises';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { Control } from './control';

// Webview provider for the Resources view: the SSH hosts and keys the signed-in CyberShuttle account holds in
// cs-control. Only hosts cs-control wrote (`managed`) may be removed, so they render as the editable source.
export class SshHostProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.hostsView';
    protected readonly viewKind = 'hosts' as const;

    constructor(extensionUri: vscode.Uri, private readonly control: Control) {
        super(extensionUri);
        control.onDidChange(() => this.refreshSshHosts());
    }

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case 'ready': this.pushState(); break;
            case 'signIn': void vscode.commands.executeCommand('csbridge.signIn'); break;
            case 'removeSshHost': void this.remove(`SSH host '${data.name}'`, () => this.control.deleteSshHost(data.name ?? '')); break;
            case 'removeSshKey': void this.remove(`SSH key '${data.name}'`, () => this.control.deleteSshKey(data.name ?? '')); break;
            case 'addSshKey': void this.attempt(() => this.addSshKey()); break;
            default: this.logger.warn('Unknown command from hosts webview:', data);
        }
    }

    protected async pushState(): Promise<void> {
        if (!this.view) { return; }
        const state: HostsState = { sshHosts: [], sshKeys: [], account: await this.control.accountName() };
        if (state.account) {
            try {
                const [hosts, keys] = await Promise.all([this.control.listSshHosts(), this.control.listSshKeys()]);
                state.sshHosts = hosts.map(host => ({ ...host, source: host.managed ? 'user' : 'system' }));
                state.sshKeys = keys;
            }
            catch (err) { this.showError('Failed to load CyberShuttle resources', err); }
        }
        this.view.webview.postMessage({ command: 'state', state });
    }

    // Title-bar action: re-read so resources added elsewhere (e.g. from CyberShuttle Jupyter) appear.
    public refreshSshHosts(): void {
        this.pushState();
    }

    public addSshHost(): Promise<void> {
        return this.attempt(async () => {
            const name = await ask('Alias for this host, e.g. delta');
            const command = name && await ask('The ssh command that works, e.g. ssh alice@login.delta.edu');
            if (!command) { return; }
            const keys = (await this.control.listSshKeys()).map(k => k.name);
            const key = keys.length ? await vscode.window.showQuickPick(keys, { placeHolder: 'Login key, or Escape for none' }) : undefined;
            await this.control.addSshHost(name, command, key);
        });
    }

    // The private key is read once and handed to cs-control; nothing here keeps or logs it.
    private async addSshKey(): Promise<void> {
        const name = await ask('Name for this key, e.g. delta-key');
        const file = name ? (await vscode.window.showOpenDialog({ openLabel: 'Add key' }))?.[0] : undefined;
        if (file) { await this.control.addSshKey(name, await readFile(file.fsPath, 'utf-8')); }
    }

    private async remove(what: string, action: () => Promise<unknown>): Promise<void> {
        if (await confirmModal(`Remove ${what} from CyberShuttle?`, 'Remove')) { await this.attempt(action); }
    }

    private async attempt(action: () => Promise<unknown>): Promise<void> {
        try { await action(); }
        catch (err) { this.showError('CyberShuttle request failed', err); }
        await this.pushState();
    }
}

async function ask(placeHolder: string): Promise<string> {
    return (await vscode.window.showInputBox({ placeHolder, ignoreFocusOut: true }))?.trim() ?? '';
}

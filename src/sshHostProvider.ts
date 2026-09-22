import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { HostsState, WebviewMessage } from './models';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { errMsg } from './logger';
import { AuthClient } from './control/AuthClient';
import { ControlClient } from './control/ControlClient';
import type { SshKey } from './control/types';

// The Resources view shows what the signed-in CyberShuttle account owns in cs-control: its SSH
// hosts and the login keys assigned to them. It reads and writes nothing locally, and offers only
// the operations cs-control has, so a host is added or corrected by pasting the ssh command that
// works and letting the server parse it. A failed call leaves its message in the view, where the
// row it belongs to still is, rather than in a notification.
export class SshHostProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.hostsView';
    protected readonly viewKind = 'hosts' as const;

    // The keys the view last showed, so a key pick never re-fetches what is already on screen.
    private keys: SshKey[] = [];

    constructor(extensionUri: vscode.Uri, private readonly auth: AuthClient, private readonly control: ControlClient) {
        super(extensionUri);
        auth.onDidChange(() => void this.pushState());
    }

    protected handleMessage(data: WebviewMessage): void {
        const name = data.name ?? '';
        switch (data.command) {
            case 'ready': void this.pushState(); break;
            case 'signIn': void vscode.commands.executeCommand('csbridge.signIn'); break;
            case 'signOut': void vscode.commands.executeCommand('csbridge.signOut'); break;
            case 'testHost': void this.attempt(() => this.testHost(name)); break;
            case 'editHost': void this.attempt(() => this.editHost(name, data.key)); break;
            case 'deleteHost': void this.attempt(() => this.deleteHost(name)); break;
            case 'addKey': void this.attempt(() => this.addKey()); break;
            case 'deleteKey': void this.attempt(() => this.deleteKey(name)); break;
            default: this.logger.warn('Unknown command from hosts webview:', data);
        }
    }

    protected async pushState(error = ''): Promise<void> {
        if (!this.view) { return; }
        const state: HostsState = { account: await this.auth.accountName(), hosts: [], keys: [], error };
        if (state.account) {
            try { [state.hosts, state.keys] = await Promise.all([this.control.listSshHosts(), this.control.listSshKeys()]); }
            catch (err) { state.error ||= errMsg(err); }
        }
        this.keys = state.keys;
        this.view.webview.postMessage({ command: 'state', state });
    }

    public refresh(): void { void this.pushState(); }

    public async addSshHost(): Promise<void> {
        await this.attempt(async () => {
            if (!await this.auth.accountName()) { throw new Error('Log in to CyberShuttle first.'); }
            const name = await ask('Add SSH host', 'Alias for this host, e.g. delta');
            if (!name) { return; }
            const command = await ask('Add SSH host', 'The ssh command that works, e.g. ssh -J bastion alice@login.delta.edu');
            if (!command) { return; }
            await this.control.addSshHost(name, command, await this.pickKey());
        });
    }

    // cs-control stores the resolved host, not the command that made it, so an edit starts empty.
    private async editHost(name: string, currentKey?: string): Promise<void> {
        const command = await ask(`Edit ${name}`, 'The ssh command that works');
        if (!command) { return; }
        await this.control.updateSshHost(name, command, await this.pickKey(currentKey));
    }

    private async testHost(name: string): Promise<void> {
        const result = await this.control.testSshHost(name);
        if (!result.ok) { throw new Error(result.message); }
        vscode.window.showInformationMessage(`${name}: ${result.message}`);
    }

    private async deleteHost(name: string): Promise<void> {
        if (!await confirmModal(`Remove SSH host '${name}' from CyberShuttle?`, 'Remove')) { return; }
        await this.control.deleteSshHost(name);
    }

    // The private bytes are read once and handed to cs-control; nothing keeps or logs them.
    private async addKey(): Promise<void> {
        const name = await ask('Add SSH key', 'Name for this key, e.g. delta-key');
        if (!name) { return; }
        const picked = await vscode.window.showOpenDialog({ title: 'Select a private key', canSelectMany: false, openLabel: 'Add key' });
        if (!picked?.length) { return; }
        await this.control.addSshKey(name, await readFile(picked[0].fsPath, 'utf-8'));
    }

    private async deleteKey(name: string): Promise<void> {
        if (!await confirmModal(`Remove SSH key '${name}' from CyberShuttle?`, 'Remove', 'Every host using it is unassigned.')) { return; }
        await this.control.deleteSshKey(name);
    }

    // Escape means no key.
    private async pickKey(current?: string): Promise<string> {
        if (this.keys.length === 0) { return ''; }
        return await vscode.window.showQuickPick(this.keys.map(k => k.name), {
            title: 'Login key',
            placeHolder: current ? `Currently ${current}; Escape to unassign` : 'Choose a stored key, or Escape for none',
        }) ?? '';
    }

    // One failure path for every action: show what cs-control said, then re-render off its state.
    private async attempt(action: () => Promise<void>): Promise<void> {
        let error = '';
        try { await action(); }
        catch (err) { error = errMsg(err); }
        await this.pushState(error);
    }
}

async function ask(title: string, placeHolder: string): Promise<string> {
    return (await vscode.window.showInputBox({ title, placeHolder, ignoreFocusOut: true }))?.trim() ?? '';
}

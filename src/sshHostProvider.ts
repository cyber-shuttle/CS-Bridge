// Resources view provider. Read-only until the user confirms the one-time conversion; after that every edit
// goes through validateAndCommit. An emptied field drops its directive, since ssh -G rejects or replaces an
// empty value.
import * as vscode from 'vscode';
import { HostsState, SSHHost, WebviewMessage } from './models';
import { WebviewProvider, confirmModal } from './webviewProvider';
import { errMsg } from './logger';
import { SshManager } from './modules/sshSupport';
import { sshCommandToConfig, assertValidHost, SshConfigEntry } from './modules/sshCommandParser';
import { discoverKeys } from './modules/sshKeyStore';
import { systemRunner } from './modules/commandRunner';
import { USER_SSH_CONFIG_PATH, isConverted, convertToCanonical, importHosts, validateAndCommit } from './modules/sshHostsStore';

const EDITABLE_FIELDS = new Set(['hostname', 'user', 'port', 'proxyjump', 'forwardagent']);

const setDirective = (host: SSHHost, key: string, values: string[]): void => {
    if (values.length) { host.Config[key] = values; }
    else { delete host.Config[key]; }
};

export class SshHostProvider extends WebviewProvider {
    public static readonly viewType = 'csbridge.hostsView';
    protected readonly viewKind = 'hosts' as const;

    protected handleMessage(data: WebviewMessage): void {
        switch (data.command) {
            case 'ready': this.pushState(); break;
            case 'convert': void this.ensureConverted().then(() => this.pushState()); break;
            case 'removeSshHost': void this.removeSshHost(data.name ?? ''); break;
            case 'openTerminal': this.openTerminal(data.name ?? ''); break;
            case 'renameHost': void this.mutateHost(data.name ?? '', (h) => { h.Name = data.value ?? h.Name; }); break;
            case 'editHostField': void this.mutateHost(data.name ?? '', (h) => { if (EDITABLE_FIELDS.has(data.field ?? '')) { setDirective(h, data.field!, data.value ? [data.value] : []); } }); break;
            case 'addIdentityFile': void this.mutateHost(data.name ?? '', (h) => { (h.Config.identityfile ??= []).push(data.identityFile ?? ''); }, data.identityFile); break;
            case 'removeIdentityFile': void this.mutateHost(data.name ?? '', h => setDirective(h, 'identityfile', (h.Config.identityfile ?? []).filter(f => f !== data.identityFile))); break;
            default: this.logger.warn('Unknown command from hosts webview:', data);
        }
    }

    protected pushState(): void {
        if (!this.view) { return; }
        const sshHosts = importHosts(systemRunner);
        const state: HostsState = { converted: isConverted(), sshHosts, sshKeys: discoverKeys(sshHosts, systemRunner) };
        this.view.webview.postMessage({ command: 'state', state });
    }

    // Rides the host's ControlMaster socket (Unix), so a shell on an already-authenticated host costs no second 2FA push.
    private openTerminal(name: string): void {
        vscode.window.createTerminal({ name, shellPath: 'ssh', shellArgs: [...SshManager.getInstance().buildControlMasterArgs(name), name] }).show();
    }

    // Title-bar action: re-read so hosts added externally (e.g. via Remote-SSH) appear without a window reload.
    public refreshSshHosts(): void {
        this.pushState();
    }

    private async ensureConverted(): Promise<boolean> {
        if (isConverted()) { return true; }
        const ok = await confirmModal(
            'Convert ~/.ssh/config for CS Bridge?',
            'Convert',
            'CS Bridge rewrites ~/.ssh/config into a flattened, machine-managed form so hosts and keys can be edited here. '
            + 'The original is saved once to ~/.ssh/config.csbridge-backup. This runs only once.',
        );
        if (!ok) { return false; }
        try { convertToCanonical(systemRunner); }
        catch (err) { this.showError('SSH config conversion failed', err); return false; }
        return true;
    }

    // Every write to ~/.ssh/config: converted first, validated, then the view refreshed either way.
    private async commit(errorTitle: string, edit: Parameters<typeof validateAndCommit>[1]): Promise<boolean> {
        if (!(await this.ensureConverted())) { return false; }
        let ok = true;
        try { validateAndCommit(systemRunner, edit); }
        catch (err) { this.showError(errorTitle, err); ok = false; }
        this.pushState();
        return ok;
    }

    private mutateHost(alias: string, mutate: (h: SSHHost) => void, keyPath?: string): Promise<boolean> {
        return this.commit('SSH host edit rejected', (hosts) => {
            const host = hosts.find(h => h.Name === alias);
            if (!host) { throw new Error(`Host '${alias}' not found`); }
            if (keyPath !== undefined && !discoverKeys(hosts, systemRunner).some(k => k.path === keyPath && k.status === 'private')) {
                throw new Error(`'${keyPath}' is not an assignable private key`);
            }
            mutate(host);
            return { hosts, edited: host.Name };
        });
    }

    public async addSshHost(): Promise<void> {
        if (!(await this.ensureConverted())) { return; }

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

        const { Host, ...rest } = entry;
        const config = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key.toLowerCase(), [value]]));
        const added = await this.commit('Failed to save SSH host', hosts => ({ hosts: [...hosts.filter(h => h.Name !== Host), { Name: Host, Config: config }], edited: Host }));
        if (!added) { return; }

        const choice = await vscode.window.showInformationMessage('Host added!', 'Open Config', 'Connect');
        if (choice === 'Open Config') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(USER_SSH_CONFIG_PATH));
        }
        else if (choice === 'Connect') {
            void vscode.commands.executeCommand('csbridge.newSessionOnHost', Host);
        }
    }

    private async removeSshHost(name: string): Promise<void> {
        if (!(await this.ensureConverted())) { return; }
        const choice = await vscode.window.showWarningMessage(
            `Remove SSH host '${name}'?`,
            { modal: true, detail: 'This removes the Host entry from ~/.ssh/config.' },
            'Remove',
        );
        if (choice !== 'Remove') { return; }
        await this.commit(`Failed to remove SSH host ${name}`, hosts => ({ hosts: hosts.filter(h => h.Name !== name) }));
    }
}

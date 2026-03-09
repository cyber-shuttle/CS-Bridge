import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { SshManager } from './SshManager.js';

interface BrowseEntry {
    name: string;
    isDir: boolean;
    size: string;
}

interface BrowseHistoryEntry {
    host: string;
    path: string;
}

export class StorageBrowserManager {
    // Storages panel state
    private _browseHost: string | null = null;
    private _browseHistory: BrowseHistoryEntry[] = [];
    private _browseCursor = -1;
    private _browseRequestId: Map<string, number> = new Map();

    constructor(
        private readonly _ssh: SshManager,
        private readonly _postStoragesMessage: (msg: unknown) => void,
    ) {}

    // Getters for state needed by HTML rendering
    get browseHost(): string | null { return this._browseHost; }
    get browseHistory(): BrowseHistoryEntry[] { return this._browseHistory; }
    get browseCursor(): number { return this._browseCursor; }

    /**
     * Browse a directory on a remote SSH host — sends results to the Storages panel.
     */
    async browseRemoteDir(hostName: string, remotePath: string): Promise<void> {
        const reqId = (this._browseRequestId.get(hostName) ?? 0) + 1;
        this._browseRequestId.set(hostName, reqId);
        this._postStoragesMessage({ type: 'storagesListing', host: hostName, path: remotePath, loading: true, entries: [] });
        try {
            const resolvedRemote = remotePath === '~'
                ? '$HOME'
                : remotePath.startsWith('~/')
                    ? '$HOME' + remotePath.slice(1)
                    : remotePath;
            const result = await this._ssh.runShellCommand(
                hostName,
                `cd "${resolvedRemote.replace(/"/g, '\\"')}" && pwd && ls -lAhp`,
            );
            if (this._browseRequestId.get(hostName) !== reqId) {
                return;
            }
            if (result.code === 0) {
                const lines = result.stdout.split('\n');
                const resolvedPath = lines[0].trim();
                const entries: BrowseEntry[] = [];
                for (let i = 2; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) { continue; }
                    const parts = line.split(/\s+/);
                    if (parts.length < 9) { continue; }
                    const size = parts[4];
                    const name = parts.slice(8).join(' ');
                    if (name === './' || name === '../') { continue; }
                    const isDir = name.endsWith('/');
                    entries.push({ name: isDir ? name.slice(0, -1) : name, isDir, size });
                }
                entries.sort((a, b) => {
                    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }
                    return a.name.localeCompare(b.name);
                });
                this._postStoragesMessage({ type: 'storagesListing', host: hostName, path: resolvedPath, loading: false, entries });
            } else {
                this._postStoragesMessage({ type: 'storagesListing', host: hostName, path: remotePath, loading: false, entries: [], error: `exit code ${result.code}` });
            }
        } catch (err: any) {
            if (this._browseRequestId.get(hostName) !== reqId) {
                return;
            }
            this._postStoragesMessage({ type: 'storagesListing', host: hostName, path: remotePath, loading: false, entries: [], error: err.message });
        }
    }

    /**
     * Fetch a remote file's content and open it in a VS Code editor tab.
     */
    async openRemoteFile(hostName: string, remotePath: string): Promise<void> {
        try {
            const result = await this._ssh.runShellCommand(hostName, `cat "${remotePath.replace(/"/g, '\\"')}"`);
            if (result.code !== 0) {
                vscode.window.showErrorMessage(`Failed to read file: exit code ${result.code}`);
                return;
            }
            const fileName = remotePath.split('/').pop() || 'untitled';
            const pathHash = crypto.createHash('md5').update(remotePath).digest('hex').slice(0, 8);
            const tmpDir = path.join(os.tmpdir(), 'cybershuttle-files');
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }
            const tmpFile = path.join(tmpDir, `${hostName}-${pathHash}-${fileName}`);
            fs.writeFileSync(tmpFile, result.stdout);
            const doc = await vscode.workspace.openTextDocument(tmpFile);
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open remote file: ${err.message}`);
        }
    }

    navigateTo(host: string, browsePath: string): void {
        this._browseHost = host;
        this._browseHistory = this._browseHistory.slice(0, this._browseCursor + 1);
        this._browseHistory.push({ host, path: browsePath });
        this._browseCursor = this._browseHistory.length - 1;
    }

    goBack(): boolean {
        if (this._browseCursor > 0) {
            this._browseCursor--;
            const entry = this._browseHistory[this._browseCursor];
            this._browseHost = entry.host;
            return true;
        }
        return false;
    }

    goForward(): boolean {
        if (this._browseCursor < this._browseHistory.length - 1) {
            this._browseCursor++;
            const entry = this._browseHistory[this._browseCursor];
            this._browseHost = entry.host;
            return true;
        }
        return false;
    }

    browseCurrent(): void {
        const current = this._browseHistory[this._browseCursor];
        if (current) {
            this.browseRemoteDir(current.host, current.path);
        }
    }

    goHome(): void {
        this._browseHost = null;
        this._browseHistory = [];
        this._browseCursor = -1;
    }

    refresh(): void {
        if (this._browseHost) {
            this.browseCurrent();
        }
    }
}

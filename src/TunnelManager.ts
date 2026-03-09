import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { MetricsCollector } from './instrumentation/index.js';

export interface TunnelCredentials {
    provider: 'devtunnel' | 'frp';
    authToken: string;
    serverUrl?: string;
}

export class TunnelManager {
    private _devTunnelAccount: string | null = null;

    static readonly DEV_TUNNELS_APP_ID = '46da2f7e-b5ef-422a-88d4-2a7f9de6a0b2';
    static readonly DEV_TUNNELS_SCOPE = `${TunnelManager.DEV_TUNNELS_APP_ID}/.default`;

    /** Fires when auth state changes. Listener receives the new account label or null. */
    onAuthStateChanged?: (account: string | null) => void;

    constructor(
        private readonly _outputChannel: vscode.OutputChannel,
        private readonly _metrics: MetricsCollector,
    ) {}

    /* ------------------------------------------------------------------ */
    /*  Provider-agnostic credentials                                      */
    /* ------------------------------------------------------------------ */

    /** Read the configured tunnel provider from VS Code settings. */
    getProvider(): string {
        const config = vscode.workspace.getConfiguration('cybershuttle');
        return config.get<string>('tunnelProvider') || 'devtunnel';
    }

    /**
     * Get credentials for the configured tunnel provider.
     * - devtunnel: acquires Microsoft Entra ID token interactively
     * - frp: reads API key and server URL from settings
     */
    async getCredentials(): Promise<TunnelCredentials> {
        const provider = this.getProvider();
        if (provider === 'frp') {
            const config = vscode.workspace.getConfiguration('cybershuttle');
            const serverUrl = config.get<string>('frpServerUrl') || '';
            const apiKey = config.get<string>('frpApiKey') || '';
            if (!serverUrl || !apiKey) {
                throw new Error('FRP tunnel provider requires cybershuttle.frpServerUrl and cybershuttle.frpApiKey settings');
            }
            return { provider: 'frp', authToken: apiKey, serverUrl };
        }
        // devtunnel
        const authToken = await this.getDevTunnelAuthToken();
        return { provider: 'devtunnel', authToken };
    }

    /* ------------------------------------------------------------------ */
    /*  Dev Tunnels auth (Microsoft Entra ID)                              */
    /* ------------------------------------------------------------------ */

    async checkDevTunnelAuth(): Promise<void> {
        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [TunnelManager.DEV_TUNNELS_SCOPE],
                { silent: true },
            );
            if (session) {
                this._devTunnelAccount = session.account.label;
                this._outputChannel.appendLine('Dev Tunnels: signed in as ' + session.account.label);
            } else {
                this._devTunnelAccount = null;
            }
        } catch {
            this._devTunnelAccount = null;
        }
        this.onAuthStateChanged?.(this._devTunnelAccount);
    }

    async signInDevTunnel(): Promise<void> {
        try {
            await this.getDevTunnelAuthToken();
            const session = await vscode.authentication.getSession(
                'microsoft',
                [TunnelManager.DEV_TUNNELS_SCOPE],
                { silent: true },
            );
            this._devTunnelAccount = session?.account.label ?? 'Signed in';
            this._outputChannel.appendLine('Dev Tunnels: signed in as ' + this._devTunnelAccount);
        } catch (err: any) {
            this._devTunnelAccount = null;
            vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${err.message}`);
        }
        this.onAuthStateChanged?.(this._devTunnelAccount);
    }

    async switchDevTunnelAccount(): Promise<void> {
        try {
            await vscode.authentication.getSession(
                'microsoft',
                [TunnelManager.DEV_TUNNELS_SCOPE],
                { silent: true },
            );
        } catch {
            // ignore
        }

        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [TunnelManager.DEV_TUNNELS_SCOPE],
                { clearSessionPreference: true, createIfNone: true },
            );
            this._devTunnelAccount = session.account.label;
            this._outputChannel.appendLine('Dev Tunnels: switched to ' + session.account.label);
        } catch (err: any) {
            this._devTunnelAccount = null;
            vscode.window.showErrorMessage(`Dev Tunnels sign-in failed: ${err.message}`);
        }
        this.onAuthStateChanged?.(this._devTunnelAccount);
    }

    async signOutDevTunnel(): Promise<void> {
        this._devTunnelAccount = null;
        this._outputChannel.appendLine('Dev Tunnels: signed out');
        this.onAuthStateChanged?.(this._devTunnelAccount);
    }

    get devTunnelAccount(): string | null {
        return this._devTunnelAccount;
    }

    async getDevTunnelAuthToken(): Promise<string> {
        const authStart = Date.now();
        try {
            const session = await vscode.authentication.getSession(
                'microsoft',
                [TunnelManager.DEV_TUNNELS_SCOPE],
                { createIfNone: true },
            );
            this._devTunnelAccount = session.account.label;
            this.onAuthStateChanged?.(this._devTunnelAccount);
            this._metrics.record('auth_flow', 'success', { stage: 'token_exchange' }, Date.now() - authStart);
            return session.accessToken;
        } catch (err: any) {
            this._metrics.record('auth_flow', 'failure', { stage: 'token_exchange' }, Date.now() - authStart, err.message);
            throw err;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  DevTunnel CLI binary management                                    */
    /* ------------------------------------------------------------------ */

    resolveDevTunnelBin(): string | undefined {
        const candidates = [
            path.join(os.homedir(), '.cybershuttle', 'bin', 'devtunnel'),
            path.join(os.homedir(), '.linkspan', 'bin', 'devtunnel'),
            '/opt/homebrew/bin/devtunnel',
            '/usr/local/bin/devtunnel',
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
        return undefined;
    }

    async ensureDevTunnel(): Promise<string> {
        const existing = this.resolveDevTunnelBin();
        if (existing) {
            return existing;
        }

        const binDir = path.join(os.homedir(), '.cybershuttle', 'bin');
        const binPath = path.join(binDir, 'devtunnel');

        const platformMap: Record<string, string> = { darwin: 'osx', linux: 'linux' };
        const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64' };
        const osName = platformMap[process.platform];
        const archName = archMap[process.arch];

        if (!osName || !archName) {
            throw new Error(`Unsupported platform for devtunnel: ${process.platform}/${process.arch}`);
        }

        const downloadUrl = `https://tunnelsassetsprod.blob.core.windows.net/cli/${osName}-${archName}-devtunnel`;
        this._outputChannel.appendLine(`[devtunnel] Downloading from ${downloadUrl}`);

        fs.mkdirSync(binDir, { recursive: true });
        execSync(`curl -fsSL -o "${binPath}" "${downloadUrl}" && chmod +x "${binPath}"`, {
            timeout: 60_000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this._outputChannel.appendLine(`[devtunnel] Downloaded to ${binPath}`);
        return binPath;
    }
}

// CyberShuttle's control plane, as the Resources and Stats views use it. Sign-in is CILogon's device grant,
// relayed by cs-plane because it holds the client secret: the user approves a short code in the browser while
// this redeems it. The credential lives in SecretStorage and refreshes single-flight; a 401 or a failed refresh
// signs out. cs-plane wants an Origin on every request and accepts this loopback one.
import type * as vscode from 'vscode';
import type { SshHost } from './models';

export const CONTROL_URL = 'https://jupyterapi.cybershuttle.org/api/v1';
const CREDENTIAL_KEY = 'csbridge.control.credential';

interface DeviceCode { deviceCode: string; userCode: string; verificationUriComplete: string; intervalSeconds: number }
export interface SshKey { name: string; type: string; fingerprint: string }
interface ControlRun {
    sessionId: string;
    seq: number;
    sshHost: string;
    account?: string;
    partition: string;
    finalState: string;
    endedAt: string;
    stats?: { cpuEfficiencyPct?: number; memoryEfficiencyPct?: number };
}
interface Tokens { idToken: string; refreshToken?: string; expiresInSeconds: number }
interface Credential { idToken: string; refreshToken?: string; expiresAt: number }

class ControlError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export class Control {
    private credential: Credential | undefined;
    private loaded = false;
    private refreshing: Promise<void> | undefined;
    private readonly listeners: Array<() => void> = [];

    constructor(private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>, private readonly fetchImpl = globalThis.fetch) { }

    public onDidChange(listener: () => void): void { this.listeners.push(listener); }

    // Display only: cs-plane verifies the id token on every call.
    public async accountName(): Promise<string | undefined> {
        const idToken = (await this.load())?.idToken;
        if (!idToken) { return undefined; }
        const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString() || '{}');
        return claims.email ?? claims.name ?? claims.sub;
    }

    public startSignIn(): Promise<DeviceCode> {
        return this.request('oauth/device', 'POST') as Promise<DeviceCode>;
    }

    // Redeems the device code every interval until the user approves it; false if they cancel first.
    public async awaitSignIn(code: DeviceCode, cancelled: () => boolean): Promise<boolean> {
        while (!cancelled()) {
            await new Promise(resolve => setTimeout(resolve, code.intervalSeconds * 1000));
            if (cancelled()) { return false; }
            try {
                await this.store(await this.request('oauth/exchange', 'POST', { deviceCode: code.deviceCode }) as Tokens);
                return true;
            }
            catch (err) {
                if (!(err instanceof ControlError) || err.code !== 'authorization_pending') { throw err; }
            }
        }
        return false;
    }

    public async signOut(): Promise<void> {
        this.credential = undefined;
        this.loaded = true;
        await this.secrets.delete(CREDENTIAL_KEY);
        this.listeners.forEach(listener => listener());
    }

    public listSshHosts() { return this.list<SshHost & { managed?: boolean }>('ssh/hosts', 'hosts'); }
    public addSshHost(name: string, command: string, key = '') { return this.api('ssh/hosts', 'POST', { name, command, key }); }
    public deleteSshHost(name: string) { return this.api(`ssh/hosts/${encodeURIComponent(name)}`, 'DELETE'); }
    public listSshKeys() { return this.list<SshKey>('ssh/keys', 'keys'); }
    public addSshKey(name: string, privateKey: string) { return this.api('ssh/keys', 'POST', { name, privateKey }); }
    public deleteSshKey(name: string) { return this.api(`ssh/keys/${encodeURIComponent(name)}`, 'DELETE'); }
    public listRuns() { return this.list<ControlRun>('telemetry', 'runs'); }

    private async list<T>(path: string, field: string): Promise<T[]> {
        return ((await this.api(path)) as Record<string, T[]>)[field];
    }

    private async api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
        const credential = await this.load();
        if (credential && Date.now() > credential.expiresAt - 60_000) {
            this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
            await this.refreshing;
        }
        if (!this.credential) { throw new ControlError(401, 'unauthorized', 'Log in to CyberShuttle first.'); }
        try {
            return await this.request(path, method, body, this.credential.idToken);
        }
        catch (err) {
            if (err instanceof ControlError && err.status === 401) { await this.signOut(); }
            throw err;
        }
    }

    private async refresh(credential: Credential): Promise<void> {
        try {
            const tokens = await this.request('oauth/refresh', 'POST', { refreshToken: credential.refreshToken }) as Tokens;
            await this.store({ ...tokens, refreshToken: tokens.refreshToken ?? credential.refreshToken });
        }
        catch {
            await this.signOut();
        }
    }

    private async store(tokens: Tokens): Promise<void> {
        this.credential = { idToken: tokens.idToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + tokens.expiresInSeconds * 1000 };
        this.loaded = true;
        await this.secrets.store(CREDENTIAL_KEY, JSON.stringify(this.credential));
        this.listeners.forEach(listener => listener());
    }

    private async load(): Promise<Credential | undefined> {
        if (!this.loaded) {
            this.credential = JSON.parse(await this.secrets.get(CREDENTIAL_KEY) ?? 'null') ?? undefined;
            this.loaded = true;
        }
        return this.credential;
    }

    private async request(path: string, method: string, body?: unknown, token?: string): Promise<unknown> {
        const headers: Record<string, string> = { 'Origin': 'http://127.0.0.1', 'Content-Type': 'application/json' };
        if (token) { headers['Authorization'] = `Bearer ${token}`; }
        const response = await this.fetchImpl(`${CONTROL_URL}/${path}`, { method, headers, body: JSON.stringify(body) });
        if (response.status === 204) { return undefined; }
        const value = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        if (!response.ok) {
            throw new ControlError(response.status, value?.error?.code ?? `http_${response.status}`, value?.error?.message ?? `CyberShuttle returned ${response.status}.`);
        }
        return value;
    }
}

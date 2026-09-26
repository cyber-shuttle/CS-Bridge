// CyberShuttle's control plane. CS Bridge launches every job itself over the user's ssh; cs-plane records the session,
// attaches the job's one tunnel, relays Connect, and keeps the run history. Sign-in is CILogon's device grant, relayed
// by cs-plane because it holds the client secret: the user approves a short code in the browser while this polls
// cs-plane to redeem it. The credential lives in SecretStorage and refreshes single-flight; a 401 or a failed refresh
// signs out, and the id token's claims are read for display only.
import type * as vscode from 'vscode';
import type { Metric, SlurmSession, Stats } from './models';
import { parseGpuClass } from './ui/logic/cluster';
import { wallMs } from './modules/sessionMachine';

export const CONTROL_URL = 'https://jupyterapi.cybershuttle.org/api/v1';
export const CONTROL_WS_URL = CONTROL_URL.replace(/^http/, 'ws');
const CREDENTIAL_KEY = 'csbridge.control.credential';

interface DeviceCode { deviceCode: string; userCode: string; verificationUriComplete: string; intervalSeconds: number }
interface Tokens { idToken: string; refreshToken?: string; expiresInSeconds: number }
type DevicePoll = { status: 'pending'; intervalSeconds: number } | ({ status: 'complete' } & Tokens);
interface Credential { idToken: string; refreshToken?: string; expiresAt: number }

const MESSAGES: Record<string, string> = {
    tunnel_link_required: 'The Dev Tunnel transport needs a Dev Tunnels account linked to CyberShuttle. Link one, or use the CyberShuttle transport.',
};

interface SessionSpec {
    sshHost: string;
    account?: string;
    partition: string;
    rootFolder: string;
    resources: { cores: number; memoryMb: number; wallMinutes: number; gpuType?: string; gpuCount?: number };
}
export interface PlaneSession { id: string; state: string; startedAt?: string; updatedAt: string }
type Sample = Omit<Metric, 'atMs'> & { at: string };
export interface Attachment { session: PlaneSession; port: number; link?: { url: string; token: string }; devtunnel?: { id: string; cluster: string; hostToken: string } }
export interface PlaneRun extends SessionSpec {
    sessionId: string;
    seq: number;
    launcher?: string;
    finalState: string;
    error?: string;
    startedAt?: string;
    endedAt: string;
    stats?: Stats;
    samples?: Sample[];
}

export class ControlError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

export class Control {
    private credential: Credential | undefined;
    private loaded = false;
    private refreshing: Promise<void> | undefined;
    private readonly listeners: Array<() => void> = [];

    constructor(private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>, private readonly fetchImpl = globalThis.fetch) { }

    public onDidChange(listener: () => void): void { this.listeners.push(listener); }

    public async accountName(): Promise<string | undefined> {
        const idToken = (await this.load())?.idToken;
        if (!idToken) { return undefined; }
        const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString() || '{}');
        return claims.email ?? claims.name ?? claims.sub;
    }

    public startSignIn(): Promise<DeviceCode> {
        return this.request('oauth/device', 'POST') as Promise<DeviceCode>;
    }

    public async awaitSignIn(code: DeviceCode, cancelled: () => boolean): Promise<boolean> {
        let wait = code.intervalSeconds;
        while (!cancelled()) {
            await new Promise(resolve => setTimeout(resolve, wait * 1000));
            if (cancelled()) { return false; }
            const poll = await this.request('oauth/device/poll', 'POST', { deviceCode: code.deviceCode }) as DevicePoll;
            if (poll.status === 'complete') {
                await this.store(poll);
                return true;
            }
            wait = Math.max(poll.intervalSeconds, code.intervalSeconds);
        }
        return false;
    }

    public signOut(): Promise<void> { return this.save(undefined); }

    public listRuns() { return this.list<PlaneRun>('telemetry', 'runs'); }
    public listSessions() { return this.list<PlaneSession>('sessions', 'sessions'); }
    public createSession(body: SessionSpec & { idempotencyKey: string }) { return this.api('sessions', 'POST', body) as Promise<PlaneSession>; }
    public attachSession(id: string, mode: 'websocket' | 'devtunnel') { return this.api(`sessions/${id}/attach`, 'POST', { tunnelModes: [mode] }) as Promise<Attachment>; }
    public stopSession(id: string) { return this.api(`sessions/${id}/stop`, 'POST'); }
    public deleteSession(id: string) { return this.api(`sessions/${id}`, 'DELETE'); }
    public sessionMetrics(id: string) { return this.list<Sample>(`sessions/${id}/metrics`, 'samples'); }
    public sessionAccess(id: string) { return this.api(`sessions/${id}/access`) as Promise<{ jupyter: { token: string } }>; }
    public sessionSsh(id: string, publicKey: string) { return this.api(`sessions/${id}/ssh`, 'POST', { publicKey }) as Promise<{ port: number }>; }

    private async list<T>(path: string, field: string): Promise<T[]> {
        return ((await this.api(path)) as Record<string, T[]>)[field];
    }

    private async api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
        const credential = await this.load();
        if (credential && Date.now() > credential.expiresAt - 60_000) {
            this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
            await this.refreshing;
        }
        if (!this.credential) { throw new ControlError(401, 'Log in to CyberShuttle first.'); }
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

    private store(tokens: Tokens): Promise<void> {
        return this.save({ idToken: tokens.idToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + tokens.expiresInSeconds * 1000 });
    }

    private async save(credential: Credential | undefined): Promise<void> {
        this.credential = credential;
        this.loaded = true;
        await (credential ? this.secrets.store(CREDENTIAL_KEY, JSON.stringify(credential)) : this.secrets.delete(CREDENTIAL_KEY));
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
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) { headers['Authorization'] = `Bearer ${token}`; }
        const response = await this.fetchImpl(`${CONTROL_URL}/${path}`, { method, headers, body: JSON.stringify(body) });
        if (response.status === 204) { return undefined; }
        const value = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        if (!response.ok) {
            const code = value?.error?.code ?? `http_${response.status}`;
            throw new ControlError(response.status, MESSAGES[code] ?? value?.error?.message ?? `CyberShuttle returned ${response.status}.`);
        }
        return value;
    }
}

const pad = (n: number) => String(n).padStart(2, '0');

// A card's session as cs-plane defines it, keyed by the card's local id so a relaunch reuses one cs-plane session.
export function toSpec(session: SlurmSession) {
    const gpu = session.gpuCount > 0 ? parseGpuClass(session.gpuClass) : undefined;
    return {
        idempotencyKey: session.id, sshHost: session.cluster, account: session.allocation || undefined, partition: session.queue,
        rootFolder: session.workingDirectory || '$HOME',
        resources: {
            cores: session.cpus, memoryMb: Math.round(parseFloat(session.memory) * 1024), wallMinutes: Math.round(wallMs(session.wallTime) / 60_000),
            ...(gpu ? { gpuType: gpu.gpuType.replace(/^gpu:/, '') || 'gpu', gpuCount: Number(gpu.gpuCount) } : {}),
        },
    };
}

// A finished run as the summary card it is drawn with.
export function runView(run: PlaneRun): SlurmSession {
    const r = run.resources;
    return {
        id: run.sessionId, planeId: run.sessionId, name: run.sessionId, cluster: run.sshHost, status: run.finalState === 'FAILED' ? 'failed' : 'stopped',
        jobId: `#${run.seq}`, submittedAt: Date.parse(run.startedAt ?? run.endedAt), startedAt: run.startedAt ? Date.parse(run.startedAt) : undefined,
        errorMessage: run.error ?? '', workingDirectory: run.rootFolder, queue: run.partition, allocation: run.account ?? '',
        cpus: r.cores, memory: `${r.memoryMb / 1024} GB`, wallTime: `${pad(Math.floor(r.wallMinutes / 60))}:${pad(r.wallMinutes % 60)}:00`,
        gpuCount: r.gpuCount ?? 0, gpuClass: r.gpuType ? `${r.gpuType}:${r.gpuCount}` : 'None',
    };
}

export const toMetrics = (samples: Sample[] | undefined): Metric[] => (samples ?? []).map(({ at, ...sample }) => ({ ...sample, atMs: Date.parse(at) }));

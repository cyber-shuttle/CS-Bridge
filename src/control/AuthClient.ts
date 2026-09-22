// Sign-in runs CILogon's device grant through cs-control, which holds the client secret the device code
// needs to be redeemed. An editor cannot receive a redirect, so the user approves a short code in the
// browser while this redeems it every interval. The credential lives in SecretStorage, refresh is
// single-flight, and anything that fails signs out, since a half-valid token is worse than a view that
// plainly says signed out. Tokens are never logged.
import { ControlError, controlRequest, unexpected, type Fetch, type RequestOptions } from './request';

const CREDENTIAL_KEY = 'csbridge.control.credential';
const REFRESH_MARGIN_MS = 60_000;

// vscode.SecretStorage satisfies this; tests pass a map.
export interface SecretStore {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

export interface AuthDeps {
    secrets: SecretStore;
    baseUrl: () => string;
}

// What the caller shows the user: the code to type and the page to open.
export interface DeviceAuthorization {
    deviceCode: string;
    userCode: string;
    verificationUriComplete: string;
    intervalSeconds: number;
}

interface Credential {
    idToken: string;
    refreshToken?: string;
    expiresAt: number;
}

interface OAuthTokens {
    idToken: string;
    refreshToken?: string;
    expiresInSeconds: number;
}

export class AuthClient {
    private credential: Credential | undefined;
    private loaded = false;
    private refreshing: Promise<void> | undefined;
    private readonly listeners: Array<() => void> = [];

    constructor(
        private readonly deps: AuthDeps,
        private readonly fetchImpl: Fetch = globalThis.fetch,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) { }

    public get baseUrl(): string {
        return this.deps.baseUrl();
    }

    public onDidChange(listener: () => void): void {
        this.listeners.push(listener);
    }

    // What the views print for the signed-in user; undefined is the whole of "signed out".
    public async accountName(): Promise<string | undefined> {
        const credential = await this.load();
        return credential && accountName(credential.idToken);
    }

    public async token(): Promise<string | undefined> {
        const credential = await this.load();
        if (!credential) { return undefined; }
        if (this.now() < credential.expiresAt - REFRESH_MARGIN_MS) { return credential.idToken; }
        this.refreshing ??= this.refresh(credential).finally(() => { this.refreshing = undefined; });
        await this.refreshing;
        return this.credential?.idToken;
    }

    public async startSignIn(): Promise<DeviceAuthorization> {
        const authorization = (await this.call('oauth/device', { method: 'POST' })) as DeviceAuthorization;
        if (typeof authorization?.deviceCode !== 'string' || typeof authorization.verificationUriComplete !== 'string') {
            throw unexpected('sign-in response');
        }
        return authorization;
    }

    // Redeems the device code every interval until the user approves it, answering false if they cancel. A
    // denied or expired code rejects, because the sign-in cannot be resumed.
    public async awaitSignIn(authorization: DeviceAuthorization, cancelled: () => boolean): Promise<boolean> {
        let interval = authorization.intervalSeconds;
        while (!cancelled()) {
            await this.sleep(interval * 1000);
            if (cancelled()) { return false; }
            try {
                await this.store(await this.tokens('oauth/exchange', { deviceCode: authorization.deviceCode }));
                return true;
            }
            catch (error) {
                if (!(error instanceof ControlError)) { throw error; }
                if (error.code === 'rate_limited') { interval += 5; }
                else if (error.code !== 'authorization_pending') { throw error; }
            }
        }
        return false;
    }

    public async signOut(): Promise<void> {
        this.credential = undefined;
        this.loaded = true;
        await this.deps.secrets.delete(CREDENTIAL_KEY);
        for (const listener of this.listeners) { listener(); }
    }

    private async refresh(credential: Credential): Promise<void> {
        if (!credential.refreshToken) { return this.signOut(); }
        try {
            const tokens = await this.tokens('oauth/refresh', { refreshToken: credential.refreshToken });
            await this.store({ ...tokens, refreshToken: tokens.refreshToken ?? credential.refreshToken });
        }
        catch {
            await this.signOut();
        }
    }

    private async tokens(path: string, body: Record<string, string>): Promise<OAuthTokens> {
        const tokens = (await this.call(path, { body })) as OAuthTokens;
        if (typeof tokens?.idToken !== 'string' || typeof tokens.expiresInSeconds !== 'number') { throw unexpected('sign-in response'); }
        return tokens;
    }

    private call(path: string, options: RequestOptions = {}): Promise<unknown> {
        return controlRequest(this.fetchImpl, this.baseUrl, path, options);
    }

    private async store(tokens: OAuthTokens): Promise<void> {
        this.credential = { idToken: tokens.idToken, refreshToken: tokens.refreshToken, expiresAt: this.now() + tokens.expiresInSeconds * 1000 };
        this.loaded = true;
        await this.deps.secrets.store(CREDENTIAL_KEY, JSON.stringify(this.credential));
        for (const listener of this.listeners) { listener(); }
    }

    private async load(): Promise<Credential | undefined> {
        if (!this.loaded) {
            const value: unknown = await Promise.resolve(this.deps.secrets.get(CREDENTIAL_KEY)).then(raw => JSON.parse(raw ?? 'null')).catch(() => undefined);
            this.credential = isCredential(value) ? value : undefined;
            this.loaded = true;
        }
        return this.credential;
    }
}

const isCredential = (value: unknown): value is Credential =>
    typeof (value as Credential)?.idToken === 'string' && typeof (value as Credential)?.expiresAt === 'number';

// Display only: the id token is cs-control's to verify, and it does, on every call.
function accountName(idToken: string): string | undefined {
    try {
        const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf-8')) as Record<string, unknown>;
        const name = claims.email ?? claims.name ?? claims.sub;
        return typeof name === 'string' ? name : undefined;
    }
    catch {
        return undefined;
    }
}

// Sign-in runs CILogon's device grant, brokered by cs-control because only it holds the client secret.
// An editor cannot receive a redirect, so the user types a short code at the issuer instead and this
// polls cs-control until the grant is approved; the upstream device code never reaches the client.
// The credential lives in SecretStorage, refresh is single-flight, and anything that fails signs out,
// since a half-valid token is worse than a view that plainly says signed out. Tokens and user codes
// are never logged.
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
    handle: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}

export interface Account {
    sub: string;
    email?: string;
    name?: string;
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

    public async account(): Promise<Account | undefined> {
        const credential = await this.load();
        return credential && decodeAccount(credential.idToken);
    }

    // What the views print for the signed-in user; undefined is the whole of "signed out".
    public async accountName(): Promise<string | undefined> {
        const account = await this.account();
        return account && (account.email ?? account.name ?? account.sub);
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
        const authorization = (await this.call('oauth/authorizations', { method: 'POST' })) as DeviceAuthorization;
        if (typeof authorization?.handle !== 'string' || typeof authorization.userCode !== 'string'
            || typeof authorization.verificationUriComplete !== 'string') {
            throw unexpected('sign-in response');
        }
        return authorization;
    }

    // Polls until the user approves the code, answering false when they give up rather than throwing; a
    // rejected, consumed or expired authorization is an error, because the sign-in cannot be resumed.
    public async awaitSignIn(authorization: DeviceAuthorization, cancelled: () => boolean): Promise<boolean> {
        const deadline = this.now() + authorization.expiresInSeconds * 1000;
        let interval = authorization.intervalSeconds;
        while (!cancelled()) {
            await this.sleep(Math.max(interval, 1) * 1000);
            if (cancelled()) { return false; }
            if (this.now() > deadline) { throw new Error('The CyberShuttle sign-in code expired.'); }
            const answer = await this.poll(authorization.handle, interval);
            if (answer === undefined) { return true; }
            interval = answer;
        }
        return false;
    }

    // One poll: the interval to wait next while pending, or undefined once the credential is stored.
    private async poll(handle: string, interval: number): Promise<number | undefined> {
        let answer: unknown;
        try {
            answer = await this.call(`oauth/authorizations/${encodeURIComponent(handle)}/poll`, { method: 'POST' });
        }
        catch (error) {
            // Only a poll the daemon judged too early is retried, at the pace it already asked for.
            if (error instanceof ControlError && error.status === 429) { return interval; }
            throw error;
        }
        const pending = answer as { status?: string; intervalSeconds?: number };
        if (pending?.status === 'pending') { return pending.intervalSeconds ?? interval; }
        await this.store(asTokens(answer));
        return undefined;
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
        return asTokens(await this.call(path, { body }));
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
            try {
                const raw = await this.deps.secrets.get(CREDENTIAL_KEY);
                const value: unknown = raw === undefined ? undefined : JSON.parse(raw);
                this.credential = isCredential(value) ? value : undefined;
            }
            catch {
                this.credential = undefined;
            }
            this.loaded = true;
        }
        return this.credential;
    }
}

function asTokens(value: unknown): OAuthTokens {
    const tokens = value as OAuthTokens;
    if (typeof tokens?.idToken !== 'string' || typeof tokens.expiresInSeconds !== 'number') { throw unexpected('sign-in response'); }
    return tokens;
}

const isCredential = (value: unknown): value is Credential =>
    typeof (value as Credential)?.idToken === 'string' && typeof (value as Credential)?.expiresAt === 'number';

// Display only: the id token is cs-control's to verify, and it does, on every call.
function decodeAccount(idToken: string): Account | undefined {
    const payload = idToken.split('.')[1];
    if (!payload) { return undefined; }
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>;
        const text = (claim: unknown) => (typeof claim === 'string' ? claim : undefined);
        return text(claims.sub) ? { sub: claims.sub as string, email: text(claims.email), name: text(claims.name) } : undefined;
    }
    catch {
        return undefined;
    }
}

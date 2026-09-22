// CILogon's authorization-code flow with PKCE, finished by cs-control because only it holds the
// client secret. VS Code is a native client, so the browser redirect lands on a one-shot loopback
// server rather than a page; the port is fixed because CILogon matches the redirect URI exactly.
// The credential lives in SecretStorage, refresh is single-flight, and anything that fails signs
// out, since a half-valid token is worse than a view that plainly says signed out. Tokens, codes
// and verifiers are never logged.
import * as http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { CALLBACK_PORT, CONTROL_ORIGIN, controlRequest, unexpected, type Fetch } from './request';

export const CALLBACK_URI = `${CONTROL_ORIGIN}/callback`;
const CREDENTIAL_KEY = 'csbridge.control.credential';
const REFRESH_MARGIN_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

// vscode.SecretStorage satisfies this; tests pass a map.
export interface SecretStore {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
    delete(key: string): Thenable<void>;
}

export interface AuthDeps {
    secrets: SecretStore;
    baseUrl: () => string;
    openExternal: (url: string) => Promise<unknown>;
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

interface OAuthConfig {
    authorizationEndpoint: string;
    clientId: string;
    scope: string;
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

    constructor(private readonly deps: AuthDeps, private readonly fetchImpl: Fetch = globalThis.fetch, private readonly now: () => number = Date.now) { }

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

    public async signIn(): Promise<void> {
        const config = (await this.call('oauth/config')) as OAuthConfig;
        const verifier = randomBytes(32).toString('base64url');
        const state = randomBytes(16).toString('base64url');
        const callback = await awaitCallback(state);
        try {
            const authorize = new URL(config.authorizationEndpoint);
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: config.clientId,
                redirect_uri: CALLBACK_URI,
                scope: config.scope,
                state,
                code_challenge: createHash('sha256').update(verifier).digest('base64url'),
                code_challenge_method: 'S256',
            }).toString();
            await this.deps.openExternal(authorize.toString());
            const code = await callback.code;
            await this.store(await this.tokens('oauth/exchange', { code, codeVerifier: verifier, redirectUri: CALLBACK_URI }));
        }
        finally {
            callback.close();
        }
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
        const tokens = (await this.call(path, body)) as OAuthTokens;
        if (typeof tokens?.idToken !== 'string' || typeof tokens.expiresInSeconds !== 'number') { throw unexpected('sign-in response'); }
        return tokens;
    }

    private call(path: string, body?: Record<string, string>): Promise<unknown> {
        return controlRequest(this.fetchImpl, this.baseUrl, path, { body });
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

// The redirect target, alive for one answer, returned once its port is bound so the browser is never
// sent somewhere nothing is listening. The port is freed whether the flow completes, fails or is
// abandoned.
async function awaitCallback(state: string): Promise<{ code: Promise<string>; close: () => void }> {
    let resolve!: (code: string) => void;
    let reject!: (error: Error) => void;
    const code = new Promise<string>((res, rej) => { resolve = res; reject = rej; });

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', CONTROL_ORIGIN);
        const granted = url.searchParams.get('state') === state ? url.searchParams.get('code') : null;
        res.writeHead(granted ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CyberShuttle</title></head><body style="font-family:system-ui;padding:2rem">`
            + `${granted ? 'Signed in to CyberShuttle. You can close this window.' : 'This sign-in callback did not match; start again from VS Code.'}</body></html>`,
        );
        if (granted) { resolve(granted); }
        else { reject(new Error('The CyberShuttle sign-in callback did not match this request.')); }
    });
    server.on('error', reject);
    server.listen(CALLBACK_PORT, '127.0.0.1');
    await once(server, 'listening');

    const timer = setTimeout(() => reject(new Error('CyberShuttle sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
    return {
        code,
        close: () => {
            clearTimeout(timer);
            server.closeAllConnections();
            server.close();
        },
    };
}

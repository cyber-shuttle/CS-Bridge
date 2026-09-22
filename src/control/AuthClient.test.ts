import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthClient, CALLBACK_URI } from './AuthClient';
import { Call, errorResponse, idToken, jsonResponse, recordingFetch, secretStore } from './testSupport';

const BASE = 'https://control.example/api/v1';
const CREDENTIAL_KEY = 'csbridge.control.credential';
const TOKEN = idToken({ sub: 'u1', email: 'alice@example.edu' });
const CONFIG = { authorizationEndpoint: 'https://cilogon.org/authorize', clientId: 'cilogon:/client_id/x', scope: 'openid email offline_access' };

const path = (call: Call) => call.url.slice(BASE.length + 1);
const stored = (secrets: ReturnType<typeof secretStore>) => JSON.parse(secrets.values.get(CREDENTIAL_KEY) ?? 'null');

// Answers the redirect the way the browser would, from the authorize URL the flow just built.
async function visitCallback(authorizeUrl: string): Promise<void> {
    const authorize = new URL(authorizeUrl);
    const response = await fetch(`${CALLBACK_URI}?code=the-code&state=${encodeURIComponent(authorize.searchParams.get('state') ?? '')}`);
    assert.equal(response.status, 200);
    await response.text();
}

test('signing in exchanges the callback code with its verifier and stores the credential', async () => {
    const secrets = secretStore();
    let authorizeUrl = '';
    const { calls, fetch: fetchFake } = recordingFetch(call =>
        (path(call) === 'oauth/config' ? jsonResponse(CONFIG) : jsonResponse({ idToken: TOKEN, refreshToken: 'r1', expiresInSeconds: 900 })));

    const auth = new AuthClient({
        secrets,
        baseUrl: () => BASE,
        openExternal: async (url) => { authorizeUrl = url; await visitCallback(url); },
    }, fetchFake, () => 1_000_000);
    await auth.signIn();

    const authorize = new URL(authorizeUrl);
    assert.equal(authorize.origin + authorize.pathname, CONFIG.authorizationEndpoint);
    assert.equal(authorize.searchParams.get('client_id'), CONFIG.clientId);
    assert.equal(authorize.searchParams.get('redirect_uri'), CALLBACK_URI);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorize.searchParams.get('code_challenge'));

    const exchange = calls[1];
    assert.equal(path(exchange), 'oauth/exchange');
    assert.equal(exchange.method, 'POST');
    const body = exchange.body as { code: string; codeVerifier: string; redirectUri: string };
    assert.equal(body.code, 'the-code');
    assert.equal(body.redirectUri, CALLBACK_URI);
    assert.ok(body.codeVerifier.length >= 43 && body.codeVerifier.length <= 128);
    assert.notEqual(body.codeVerifier, authorize.searchParams.get('code_challenge'));

    assert.deepEqual(stored(secrets), { idToken: TOKEN, refreshToken: 'r1', expiresAt: 1_000_000 + 900_000 });
    assert.deepEqual(await auth.account(), { sub: 'u1', email: 'alice@example.edu', name: undefined });
});

test('a credential near expiry refreshes once however many callers ask', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: 'old', refreshToken: 'r1', expiresAt: 1_000 }) });
    const { calls, fetch: fetchFake } = recordingFetch(() => jsonResponse({ idToken: TOKEN, expiresInSeconds: 900 }));
    const auth = new AuthClient({ secrets, baseUrl: () => BASE, openExternal: () => Promise.reject(new Error('not used')) }, fetchFake, () => 1_000_000);

    assert.deepEqual(await Promise.all([auth.token(), auth.token(), auth.token()]), [TOKEN, TOKEN, TOKEN]);
    assert.deepEqual(calls.map(path), ['oauth/refresh']);
    assert.deepEqual(calls[0].body, { refreshToken: 'r1' });
    // The issuer did not rotate it, so the one that still works is kept.
    assert.equal(stored(secrets).refreshToken, 'r1');
});

test('a refused refresh signs out rather than leaving a half-valid credential', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: 'old', refreshToken: 'r1', expiresAt: 1_000 }) });
    const { fetch: fetchFake } = recordingFetch(() => errorResponse(400, 'invalid_grant', 'refresh refused'));
    let changes = 0;
    const auth = new AuthClient({ secrets, baseUrl: () => BASE, openExternal: () => Promise.reject(new Error('not used')) }, fetchFake, () => 1_000_000);
    auth.onDidChange(() => { changes++; });

    assert.equal(await auth.token(), undefined);
    assert.equal(secrets.values.size, 0);
    assert.equal(await auth.account(), undefined);
    assert.equal(changes, 1);
});

test('a credential with no refresh token signs out instead of retrying', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: 'old', expiresAt: 1_000 }) });
    const { calls, fetch: fetchFake } = recordingFetch(() => jsonResponse({}));
    const auth = new AuthClient({ secrets, baseUrl: () => BASE, openExternal: () => Promise.reject(new Error('not used')) }, fetchFake, () => 1_000_000);

    assert.equal(await auth.token(), undefined);
    assert.equal(calls.length, 0);
    assert.equal(secrets.values.size, 0);
});

test('signing out clears the credential and tells the views', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: TOKEN, expiresAt: 9_000_000 }) });
    const { fetch: fetchFake } = recordingFetch(() => jsonResponse({}));
    let changes = 0;
    const auth = new AuthClient({ secrets, baseUrl: () => BASE, openExternal: () => Promise.reject(new Error('not used')) }, fetchFake, () => 1_000_000);
    auth.onDidChange(() => { changes++; });

    assert.equal(await auth.token(), TOKEN);
    await auth.signOut();
    assert.equal(await auth.token(), undefined);
    assert.equal(changes, 1);
});

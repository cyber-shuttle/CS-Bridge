import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthClient } from './AuthClient';
import { Call, errorResponse, idToken, jsonResponse, recordingFetch, secretStore } from './testSupport';

const BASE = 'https://control.example/api/v1';
const CREDENTIAL_KEY = 'csbridge.control.credential';
const TOKEN = idToken({ sub: 'u1', email: 'alice@example.edu' });

const path = (call: Call) => call.url.slice(BASE.length + 1);
const stored = (secrets: ReturnType<typeof secretStore>) => JSON.parse(secrets.values.get(CREDENTIAL_KEY) ?? 'null');

const AUTHORIZATION = {
    handle: 'h'.repeat(43),
    userCode: 'QFP-7N3-VQF',
    verificationUri: 'https://cilogon.org/device/',
    verificationUriComplete: 'https://cilogon.org/device/?user_code=QFP-7N3-VQF',
    expiresInSeconds: 900,
    intervalSeconds: 5,
};

// The device grant polls, so every test drives the clock and the wait instead of really sleeping.
function deviceAuth(answer: (call: Call) => Response, secrets = secretStore()) {
    const { calls, fetch: fetchFake } = recordingFetch(answer);
    let waited = 0;
    const auth = new AuthClient({ secrets, baseUrl: () => BASE }, fetchFake, () => 1_000_000, (ms) => { waited += ms; return Promise.resolve(); });
    return { auth, calls, secrets, waited: () => waited };
}

test('signing in starts a device authorization and polls it to a stored credential', async () => {
    let polls = 0;
    const { auth, calls, secrets, waited } = deviceAuth((call) => {
        if (path(call) === 'oauth/authorizations') { return jsonResponse(AUTHORIZATION); }
        polls++;
        return polls === 1
            ? jsonResponse({ status: 'pending', intervalSeconds: 5 })
            : jsonResponse({ idToken: TOKEN, refreshToken: 'r1', expiresInSeconds: 900 });
    });

    const authorization = await auth.startSignIn();
    assert.equal(authorization.userCode, 'QFP-7N3-VQF');
    assert.equal(await auth.awaitSignIn(authorization, () => false), true);

    assert.deepEqual(calls.map(path), [
        'oauth/authorizations',
        `oauth/authorizations/${AUTHORIZATION.handle}/poll`,
        `oauth/authorizations/${AUTHORIZATION.handle}/poll`,
    ]);
    assert.deepEqual(calls.map(c => c.method), ['POST', 'POST', 'POST']);
    assert.deepEqual(calls.map(c => c.body), [undefined, undefined, undefined]);
    assert.equal(calls[0].headers.Origin, 'http://127.0.0.1');
    assert.equal(waited(), 10_000);
    assert.deepEqual(stored(secrets), { idToken: TOKEN, refreshToken: 'r1', expiresAt: 1_000_000 + 900_000 });
    assert.deepEqual(await auth.account(), { sub: 'u1', email: 'alice@example.edu', name: undefined });
});

test('an authorization the daemon no longer holds ends sign-in without a credential', async () => {
    const { auth, secrets } = deviceAuth(call =>
        (path(call) === 'oauth/authorizations' ? jsonResponse(AUTHORIZATION) : errorResponse(404, 'not_found', 'authorization was not found')));

    await assert.rejects(auth.awaitSignIn(await auth.startSignIn(), () => false), /authorization was not found/);
    assert.equal(secrets.values.size, 0);
});

test('cancelling stops polling and stores nothing', async () => {
    let polls = 0;
    const { auth, secrets } = deviceAuth((call) => {
        if (path(call) === 'oauth/authorizations') { return jsonResponse(AUTHORIZATION); }
        polls++;
        return jsonResponse({ status: 'pending', intervalSeconds: 5 });
    });

    const authorization = await auth.startSignIn();
    assert.equal(await auth.awaitSignIn(authorization, () => polls >= 2), false);
    assert.equal(polls, 2);
    assert.equal(secrets.values.size, 0);
});

test('a credential near expiry refreshes once however many callers ask', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: 'old', refreshToken: 'r1', expiresAt: 1_000 }) });
    const { calls, fetch: fetchFake } = recordingFetch(() => jsonResponse({ idToken: TOKEN, expiresInSeconds: 900 }));
    const auth = new AuthClient({ secrets, baseUrl: () => BASE }, fetchFake, () => 1_000_000);

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
    const auth = new AuthClient({ secrets, baseUrl: () => BASE }, fetchFake, () => 1_000_000);
    auth.onDidChange(() => { changes++; });

    assert.equal(await auth.token(), undefined);
    assert.equal(secrets.values.size, 0);
    assert.equal(await auth.account(), undefined);
    assert.equal(changes, 1);
});

test('a credential with no refresh token signs out instead of retrying', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: 'old', expiresAt: 1_000 }) });
    const { calls, fetch: fetchFake } = recordingFetch(() => jsonResponse({}));
    const auth = new AuthClient({ secrets, baseUrl: () => BASE }, fetchFake, () => 1_000_000);

    assert.equal(await auth.token(), undefined);
    assert.equal(calls.length, 0);
    assert.equal(secrets.values.size, 0);
});

test('signing out clears the credential and tells the views', async () => {
    const secrets = secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: TOKEN, expiresAt: 9_000_000 }) });
    const { fetch: fetchFake } = recordingFetch(() => jsonResponse({}));
    let changes = 0;
    const auth = new AuthClient({ secrets, baseUrl: () => BASE }, fetchFake, () => 1_000_000);
    auth.onDidChange(() => { changes++; });

    assert.equal(await auth.token(), TOKEN);
    await auth.signOut();
    assert.equal(await auth.token(), undefined);
    assert.equal(changes, 1);
});

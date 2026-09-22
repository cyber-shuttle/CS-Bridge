import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Control, CONTROL_URL } from './control';

const TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'u1', email: 'alice@example.edu' })).toString('base64url')}.y`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const failure = (status: number, code: string) => json({ error: { code, message: code } }, status);

function control(answer: (path: string, method: string) => Response, stored?: object) {
    const secrets = new Map<string, string>(stored ? [['csbridge.control.credential', JSON.stringify(stored)]] : []);
    const calls: Array<{ path: string; method: string; body?: unknown; headers: Record<string, string> }> = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
        const call = { path: url.slice(CONTROL_URL.length + 1), method: init.method!, headers: init.headers as Record<string, string>, body: init.body && JSON.parse(init.body as string) };
        calls.push(call);
        return answer(call.path, call.method);
    }) as typeof fetch;
    const store = {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
    };
    return { calls, secrets, client: new Control(store, fetchFake) };
}

test('device sign-in redeems the code until approved and stores the credential', async () => {
    let polls = 0;
    const { calls, secrets, client } = control(path => (path === 'oauth/device'
        ? json({ deviceCode: 'dc', userCode: 'QFP-7N3-VQF', verificationUriComplete: 'https://cilogon.org/device/', intervalSeconds: 0 })
        : ++polls === 1 ? failure(400, 'authorization_pending') : json({ idToken: TOKEN, refreshToken: 'r1', expiresInSeconds: 900 })));

    assert.equal(await client.awaitSignIn(await client.startSignIn(), () => false), true);
    assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
        ['POST', 'oauth/device', undefined],
        ['POST', 'oauth/exchange', { deviceCode: 'dc' }],
        ['POST', 'oauth/exchange', { deviceCode: 'dc' }],
    ]);
    assert.equal(calls[0].headers['Origin'], 'http://127.0.0.1');
    assert.equal(JSON.parse(secrets.get('csbridge.control.credential')!).refreshToken, 'r1');
    assert.equal(await client.accountName(), 'alice@example.edu');
});

test('resources use their cs-control routes with the bearer, refreshing once when near expiry', async () => {
    const { calls, client } = control((path, method) => (path === 'oauth/refresh'
        ? json({ idToken: TOKEN, expiresInSeconds: 900 })
        : method === 'GET' ? json({ hosts: [], keys: [], runs: [] }) : new Response(null, { status: 204 })), { idToken: 'old', refreshToken: 'r1', expiresAt: 0 });

    await Promise.all([client.listSshHosts(), client.listSshKeys(), client.listRuns()]);
    await client.addSshHost('delta', 'ssh alice@login.delta.edu', 'k');
    await client.deleteSshHost('a/b');
    await client.addSshKey('k', 'PRIVATE');
    await client.deleteSshKey('a/b');

    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
        'POST oauth/refresh', 'GET ssh/hosts', 'GET ssh/keys', 'GET telemetry',
        'POST ssh/hosts', 'DELETE ssh/hosts/a%2Fb', 'POST ssh/keys', 'DELETE ssh/keys/a%2Fb',
    ]);
    assert.deepEqual(calls[4].body, { name: 'delta', command: 'ssh alice@login.delta.edu', key: 'k' });
    assert.equal(calls[1].headers['Authorization'], `Bearer ${TOKEN}`);
});

test('a refused refresh or a 401 signs out', async () => {
    // An expired credential fails at refresh; a live one fails at the API.
    for (const expiresAt of [0, Date.now() + 3_600_000]) {
        const { secrets, client } = control(path => failure(path === 'oauth/refresh' ? 400 : 401, 'refused'), { idToken: TOKEN, refreshToken: 'r1', expiresAt });
        await assert.rejects(client.listSshHosts());
        assert.equal(secrets.size, 0);
        assert.equal(await client.accountName(), undefined);
    }
});

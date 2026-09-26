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

test('device sign-in polls until complete and stores the credential', async () => {
    let polls = 0;
    const { calls, secrets, client } = control(path => (path === 'oauth/device'
        ? json({ deviceCode: 'dc', userCode: 'QFP-7N3-VQF', verificationUriComplete: 'https://cilogon.org/device/', intervalSeconds: 0 })
        : ++polls === 1 ? json({ status: 'pending', intervalSeconds: 0 }) : json({ status: 'complete', idToken: TOKEN, refreshToken: 'r1', expiresInSeconds: 900 })));

    assert.equal(await client.awaitSignIn(await client.startSignIn(), () => false), true);
    assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [
        ['POST', 'oauth/device', undefined],
        ['POST', 'oauth/device/poll', { deviceCode: 'dc' }],
        ['POST', 'oauth/device/poll', { deviceCode: 'dc' }],
    ]);
    assert.equal(JSON.parse(secrets.get('csbridge.control.credential')!).refreshToken, 'r1');
    assert.equal(await client.accountName(), 'alice@example.edu');
});

test('calls carry the bearer, refreshing once when near expiry', async () => {
    const { calls, client } = control((path, method) => (path === 'oauth/refresh'
        ? json({ idToken: TOKEN, expiresInSeconds: 900 })
        : method === 'GET' ? json({ sessions: [], runs: [] }) : new Response(null, { status: 204 })), { idToken: 'old', refreshToken: 'r1', expiresAt: 0 });

    await Promise.all([client.listSessions(), client.listRuns()]);
    await client.stopSession('s1');

    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['POST oauth/refresh', 'GET sessions', 'GET telemetry', 'POST sessions/s1/stop']);
    assert.equal(calls[1].headers['Authorization'], `Bearer ${TOKEN}`);
});

test('a refused refresh (expired) or a 401 (live) signs out', async () => {
    for (const expiresAt of [0, Date.now() + 3_600_000]) {
        const { secrets, client } = control(path => failure(path === 'oauth/refresh' ? 400 : 401, 'refused'), { idToken: TOKEN, refreshToken: 'r1', expiresAt });
        await assert.rejects(client.listRuns());
        assert.equal(secrets.size, 0);
        assert.equal(await client.accountName(), undefined);
    }
});

test('attach asks for the chosen tunnel, and a missing Dev Tunnels link reads as such', async () => {
    const { calls, client } = control(() => failure(409, 'tunnel_link_required'), { idToken: TOKEN, expiresAt: Date.now() + 3_600_000 });
    await assert.rejects(client.attachSession('s1', 'devtunnel'), /Dev Tunnels account linked/);
    assert.deepEqual([calls[0].path, calls[0].body], ['sessions/s1/attach', { tunnelModes: ['devtunnel'] }]);
});

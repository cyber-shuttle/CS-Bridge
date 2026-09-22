import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthClient } from './AuthClient';
import { ControlClient } from './ControlClient';
import { ControlError, CONTROL_ORIGIN } from './request';
import { Call, errorResponse, idToken, jsonResponse, recordingFetch, secretStore } from './testSupport';

const BASE = 'https://control.example/api/v1';
const TOKEN = idToken({ sub: 'u1', email: 'alice@example.edu' });
const CREDENTIAL_KEY = 'csbridge.control.credential';

const signedIn = () => secretStore({ [CREDENTIAL_KEY]: JSON.stringify({ idToken: TOKEN, expiresAt: Date.now() + 3_600_000 }) });

function clientOver(answer: (call: Call) => Response, secrets = signedIn()) {
    const { calls, fetch } = recordingFetch(answer);
    const auth = new AuthClient({ secrets, baseUrl: () => BASE, openExternal: () => Promise.reject(new Error('not used')) }, fetch);
    return { calls, secrets, control: new ControlClient(auth, fetch) };
}

const HOST = { name: 'delta', hostname: 'login.delta.edu', user: 'alice', port: 22, extraDirectives: [], managed: true };
const KEY = { name: 'delta-key', type: 'ssh-ed25519', fingerprint: 'SHA256:abc' };
const RUN = {
    sessionId: 's-012345abcdef', seq: 1, sshHost: 'delta', partition: 'cpu', rootFolder: '$HOME/p',
    resources: { cores: 2, memoryMb: 4096, wallMinutes: 60 }, finalState: 'STOPPED', endedAt: '2030-01-01T01:00:30Z',
};

test('every request carries the loopback origin and the bearer token', async () => {
    const { calls, control } = clientOver(() => jsonResponse({ hosts: [HOST] }));
    assert.deepEqual(await control.listSshHosts(), [HOST]);
    assert.equal(calls[0].headers['Origin'], CONTROL_ORIGIN);
    assert.equal(calls[0].headers['Authorization'], `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['Accept'], 'application/json');
});

test('each method uses its cs-control route, verb and body', async () => {
    const { calls, control } = clientOver(call => (call.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(HOST)));
    await control.addSshHost('delta', 'ssh alice@login.delta.edu', 'delta-key');
    await control.updateSshHost('delta', 'ssh -p 2222 alice@login.delta.edu');
    await control.deleteSshHost('a/b');
    await control.deleteSshKey('a/b');

    assert.deepEqual(calls.map(c => [c.method, c.url]), [
        ['POST', `${BASE}/ssh/hosts`],
        ['PUT', `${BASE}/ssh/hosts/delta`],
        ['DELETE', `${BASE}/ssh/hosts/a%2Fb`],
        ['DELETE', `${BASE}/ssh/keys/a%2Fb`],
    ]);
    assert.deepEqual(calls[0].body, { name: 'delta', command: 'ssh alice@login.delta.edu', key: 'delta-key' });
    assert.deepEqual(calls[1].body, { command: 'ssh -p 2222 alice@login.delta.edu', key: '' });
});

test('the read routes unwrap their envelopes', async () => {
    const answers: Record<string, unknown> = { 'ssh/keys': { keys: [KEY] }, 'telemetry': { runs: [RUN] }, 'ssh/hosts/delta/test': { host: 'delta', ok: true, message: 'Connected.' } };
    const { calls, control } = clientOver(call => jsonResponse(answers[call.url.slice(BASE.length + 1)]));
    assert.deepEqual(await control.listSshKeys(), [KEY]);
    assert.deepEqual(await control.listRuns(), [RUN]);
    assert.deepEqual(await control.testSshHost('delta'), { host: 'delta', ok: true, message: 'Connected.' });
    assert.deepEqual(calls.map(c => c.method), ['GET', 'GET', 'POST']);
});

test('a 204 resolves undefined', async () => {
    const { control } = clientOver(() => new Response(null, { status: 204 }));
    assert.equal(await control.deleteSshKey('delta-key'), undefined);
});

test('the error envelope becomes a ControlError', async () => {
    const { control } = clientOver(() => errorResponse(409, 'ssh_host_exists', 'that alias is taken'));
    await assert.rejects(control.addSshHost('delta', 'ssh delta'), (err: ControlError) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'ssh_host_exists');
        assert.equal(err.message, 'that alias is taken');
        return true;
    });
});

test('a list envelope without its list is refused rather than returned', async () => {
    const { control } = clientOver(() => jsonResponse({ hosts: 'nope' }));
    await assert.rejects(control.listSshHosts(), (err: ControlError) => err.code === 'invalid_response');
});

test('a 401 drops the stored credential', async () => {
    const { control, secrets } = clientOver(() => errorResponse(401, 'unauthorized', 'unauthorized'));
    await assert.rejects(control.listSshHosts(), (err: ControlError) => err.status === 401);
    assert.equal(secrets.values.size, 0);
});

test('a signed-out client never reaches the network', async () => {
    const { calls, control } = clientOver(() => jsonResponse({ hosts: [] }), secretStore());
    await assert.rejects(control.listSshHosts(), (err: ControlError) => err.code === 'unauthorized');
    assert.equal(calls.length, 0);
});

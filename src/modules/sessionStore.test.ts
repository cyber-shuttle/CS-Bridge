import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmSession, SessionConnectionInfo } from '../models';
import { mergeFromDisk, mergeRecord, toPersistedRecord } from './sessionStore';

const ci = (over: Partial<SessionConnectionInfo> = {}): SessionConnectionInfo => ({ sshTunnelId: 't', sshPort: 1, region: 'r', ...over });
const sess = (id: string, over: Partial<SlurmSession> = {}): SlurmSession => ({ id, status: 'queued', ...over } as SlurmSession);

test('mergeFromDisk refreshes existing instances in place (identity kept), preserves in-memory connectionInfo, reports change', () => {
    const a = sess('a', { status: 'connected', connectionInfo: ci({ sshPrivateKey: 'SECRET', sshTunnelForwardPort: 5000 }) });
    const mem = [a];
    assert.equal(mergeFromDisk(mem, [sess('a', { status: 'stopped', connectionInfo: ci() }), sess('b')]), true);
    assert.equal(mem[0], a); // same object — references held by the monitor / in-flight connect stay valid
    assert.equal(a.status, 'stopped'); // status refreshed from disk
    assert.equal(a.connectionInfo?.sshPrivateKey, 'SECRET'); // in-memory secret kept
    assert.equal(a.connectionInfo?.sshTunnelForwardPort, 5000); // live forward port kept
    assert.deepEqual(mem.map(s => s.id), ['a', 'b']); // new id appended
});

test('mergeFromDisk drops ids no longer on disk; reports no change on an identical reconcile', () => {
    const mem = [sess('a'), sess('b')];
    assert.equal(mergeFromDisk(mem, [sess('b')]), true);
    assert.deepEqual(mem.map(s => s.id), ['b']);
    assert.equal(mergeFromDisk(mem, [sess('b')]), false);
});

test('mergeRecord upserts one record in place (identity kept, in-memory connectionInfo preserved), reports change', () => {
    const a = sess('a', { status: 'connected', connectionInfo: ci({ sshPrivateKey: 'SECRET', sshTunnelForwardPort: 5000 }) });
    const mem = [a];
    assert.equal(mergeRecord(mem, 'a', sess('a', { status: 'stopped', connectionInfo: ci() })), true);
    assert.equal(mem[0], a); // same object — monitor/connect refs stay valid
    assert.equal(a.status, 'stopped');
    assert.equal(a.connectionInfo?.sshPrivateKey, 'SECRET'); // in-memory secret kept
    assert.equal(mergeRecord(mem, 'a', sess('a', { status: 'stopped', connectionInfo: ci() })), false); // identical → no change
});

test('mergeRecord appends an unknown id and removes on a deleted (undefined) record', () => {
    const mem = [sess('a')];
    assert.equal(mergeRecord(mem, 'b', sess('b')), true); // new id from another window's write
    assert.deepEqual(mem.map(s => s.id), ['a', 'b']);
    assert.equal(mergeRecord(mem, 'a', undefined), true); // file gone → drop it
    assert.deepEqual(mem.map(s => s.id), ['b']);
    assert.equal(mergeRecord(mem, 'z', undefined), false); // deleting an id we never had → no change
});

test('toPersistedRecord strips secrets and keeps the given windowPids', () => {
    const rec = toPersistedRecord(sess('a', { status: 'connected', windowPids: [1], connectionInfo: ci({ sshPrivateKey: 'SECRET' }) }), [42]);
    assert.equal(rec.status, 'connected');
    assert.equal(rec.connectionInfo?.sshPrivateKey, undefined); // secret stripped
    assert.deepEqual(rec.windowPids, [42]); // disk windowPids preserved (owned by mutateWindowPids)
});

test('toPersistedRecord falls back to the session windowPids when none on disk', () => {
    assert.deepEqual(toPersistedRecord(sess('a', { windowPids: [7] }), undefined).windowPids, [7]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmSession, SessionConnectionInfo } from '../models';
import { mergeFromDisk, upsertRecord } from './sessionStore';

const ci = (over: Partial<SessionConnectionInfo> = {}): SessionConnectionInfo => ({ sshTunnelId: 't', sshPort: 1, region: 'r', ...over });
const sess = (id: string, over: Partial<SlurmSession> = {}): SlurmSession => ({ id, status: 'queued', ...over } as SlurmSession);

test('mergeFromDisk refreshes existing instances in place (identity kept) and preserves in-memory connectionInfo', () => {
    const a = sess('a', { status: 'connected', connectionInfo: ci({ sshPrivateKey: 'SECRET', sshTunnelForwardPort: 5000 }) });
    const mem = [a];
    mergeFromDisk(mem, [sess('a', { status: 'stopped', connectionInfo: ci() }), sess('b')]);
    assert.equal(mem[0], a); // same object — references held by the monitor / in-flight connect stay valid
    assert.equal(a.status, 'stopped'); // status refreshed from disk
    assert.equal(a.connectionInfo?.sshPrivateKey, 'SECRET'); // in-memory secret kept
    assert.equal(a.connectionInfo?.sshTunnelForwardPort, 5000); // live forward port kept
    assert.deepEqual(mem.map(s => s.id), ['a', 'b']); // new id appended
});

test('mergeFromDisk drops ids no longer on disk', () => {
    const mem = [sess('a'), sess('b')];
    mergeFromDisk(mem, [sess('b')]);
    assert.deepEqual(mem.map(s => s.id), ['b']);
});

test('upsertRecord replaces only the target, strips secrets to disk, keeps disk windowPids, leaves siblings', () => {
    const disk = [sess('a', { status: 'queued', windowPids: [42] }), sess('b', { status: 'connected' })];
    upsertRecord(disk, sess('a', { status: 'connected', connectionInfo: ci({ sshPrivateKey: 'SECRET' }) }));
    const a = disk.find(s => s.id === 'a')!;
    assert.equal(a.status, 'connected');
    assert.equal(a.connectionInfo?.sshPrivateKey, undefined); // secret stripped on disk
    assert.deepEqual(a.windowPids, [42]); // windowPids preserved from disk (owned by mutateWindowPids)
    assert.equal(disk.find(s => s.id === 'b')!.status, 'connected'); // sibling untouched
});

test('upsertRecord appends a brand-new session', () => {
    const disk: SlurmSession[] = [];
    upsertRecord(disk, sess('a'));
    assert.deepEqual(disk.map(s => s.id), ['a']);
});

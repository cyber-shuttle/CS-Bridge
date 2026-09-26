import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmSession } from '../models';
import { mergeFromDisk, mergeRecord } from './sessionStore';

const sess = (id: string, over: Partial<SlurmSession> = {}): SlurmSession => ({ id, status: 'queued', ...over } as SlurmSession);

test('mergeFromDisk refreshes existing instances in place (identity kept), reports change', () => {
    const a = sess('a', { status: 'connected' });
    const mem = [a];
    assert.equal(mergeFromDisk(mem, [sess('a', { status: 'stopped' }), sess('b')]), true);
    assert.equal(mem[0], a); // same object — references held by an in-flight launch / connect stay valid
    assert.equal(a.status, 'stopped'); // status refreshed from disk
    assert.deepEqual(mem.map(s => s.id), ['a', 'b']); // new id appended
});

test('mergeFromDisk drops ids no longer on disk; reports no change on an identical reconcile', () => {
    const mem = [sess('a'), sess('b')];
    assert.equal(mergeFromDisk(mem, [sess('b')]), true);
    assert.deepEqual(mem.map(s => s.id), ['b']);
    assert.equal(mergeFromDisk(mem, [sess('b')]), false);
});

test('mergeRecord upserts one record in place (identity kept), reports change', () => {
    const a = sess('a', { status: 'connected' });
    const mem = [a];
    assert.equal(mergeRecord(mem, 'a', sess('a', { status: 'stopped' })), true);
    assert.equal(mem[0], a); // same object — launch/connect refs stay valid
    assert.equal(a.status, 'stopped');
    assert.equal(mergeRecord(mem, 'a', sess('a', { status: 'stopped' })), false); // identical → no change
});

test('mergeRecord appends an unknown id and removes on a deleted (undefined) record', () => {
    const mem = [sess('a')];
    assert.equal(mergeRecord(mem, 'b', sess('b')), true); // new id from another window's write
    assert.deepEqual(mem.map(s => s.id), ['a', 'b']);
    assert.equal(mergeRecord(mem, 'a', undefined), true); // file gone → drop it
    assert.deepEqual(mem.map(s => s.id), ['b']);
    assert.equal(mergeRecord(mem, 'z', undefined), false); // deleting an id we never had → no change
});

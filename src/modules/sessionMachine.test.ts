import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatusTransition, isTerminal, isCloseable, isStoppable, isRelayLive } from './sessionMachine';
import { SlurmJobStatus, SlurmSession } from '../models';

test('status-category predicates classify each status correctly', () => {
    assert.deepEqual(['stopped', 'failed', 'completed'].map(isTerminal as any), [true, true, true]);
    assert.equal(isTerminal('queued'), false);

    assert.equal(isCloseable('not_started'), true);   // terminal + not_started
    assert.equal(isCloseable('stopped'), true);
    assert.equal(isCloseable('queued'), false);

    assert.equal(isStoppable('connected'), true);     // can stop a live session
    assert.equal(isStoppable('queued'), true);
    assert.equal(isStoppable('stopped'), false);      // already terminal
    assert.equal(isStoppable('not_started'), false);  // nothing to stop yet
    assert.equal(isStoppable('stopping'), false);     // a stop is already in flight

    assert.deepEqual(['ready_to_connect', 'connecting', 'connected'].map(isRelayLive as any), [true, true, true]);
    assert.equal(isRelayLive('preparing'), false);
});

test('RUNNING promotes a non-connect-phase session to preparing', () => {
    assert.deepEqual(computeStatusTransition('queued', SlurmJobStatus.RUNNING), { next: 'preparing' });
    assert.deepEqual(computeStatusTransition('submitting', SlurmJobStatus.RUNNING), { next: 'preparing' });
});

test('RUNNING does NOT pull a connect-phase / disconnected session back to preparing', () => {
    for (const s of ['preparing', 'ready_to_connect', 'connected', 'connecting', 'disconnected'] as const) {
        assert.deepEqual(computeStatusTransition(s, SlurmJobStatus.RUNNING), {}, `should not transition from ${s}`);
    }
});

test('terminal SLURM states stop monitoring with the right status', () => {
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.COMPLETED), { next: 'completed', stopMonitoring: true });
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.CANCELLED), { next: 'stopped', stopMonitoring: true });
});

test('failure states stop monitoring and carry an error message', () => {
    for (const s of [SlurmJobStatus.FAILED, SlurmJobStatus.TIMEOUT, SlurmJobStatus.OUT_OF_MEMORY]) {
        const t = computeStatusTransition('preparing', s);
        assert.equal(t.next, 'failed');
        assert.equal(t.stopMonitoring, true);
        assert.match(t.error ?? '', new RegExp(`Job ended with status: ${s}`));
    }
});

test('PENDING maps to queued without stopping monitoring', () => {
    assert.deepEqual(computeStatusTransition('submitting', SlurmJobStatus.PENDING), { next: 'queued' });
});

test('UNKNOWN fails and stops monitoring', () => {
    const t = computeStatusTransition('preparing', SlurmJobStatus.UNKNOWN);
    assert.equal(t.next, 'failed');
    assert.equal(t.stopMonitoring, true);
    assert.match(t.error ?? '', /unknown status/);
});

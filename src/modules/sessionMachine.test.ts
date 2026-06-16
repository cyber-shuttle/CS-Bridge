import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatusTransition } from './sessionMachine';
import { SlurmJobStatus } from '../models';

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
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.CANCELLED), { next: 'cancelled', stopMonitoring: true });
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

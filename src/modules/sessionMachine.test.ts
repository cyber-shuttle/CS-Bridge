import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatusTransition, isTerminal, isCloseable, isStoppable, isRelayLive, unreachableStatus, isReattachable } from './sessionMachine';
import { SlurmJobStatus } from '../models';

test('status-category predicates classify each status correctly', () => {
    assert.deepEqual((['stopped', 'failed', 'completed'] as const).map(isTerminal), [true, true, true]);
    assert.equal(isTerminal('queued'), false);

    assert.equal(isCloseable('not_started'), true); // terminal + not_started
    assert.equal(isCloseable('stopped'), true);
    assert.equal(isCloseable('interrupted'), true); // dismissed launch: removable + retryable
    assert.equal(isCloseable('awaiting_input'), false); // prompt still open
    assert.equal(isCloseable('queued'), false);

    assert.equal(isStoppable('interrupted'), false); // nothing running
    assert.equal(isStoppable('awaiting_input'), false); // waiting on the user, not running
    assert.equal(isTerminal('interrupted'), false); // retryable, not terminal

    assert.equal(isStoppable('connected'), true); // can stop a live session
    assert.equal(isStoppable('queued'), true);
    assert.equal(isStoppable('stopped'), false); // already terminal
    assert.equal(isStoppable('not_started'), false); // nothing to stop yet
    assert.equal(isStoppable('stopping'), false); // a stop is already in flight

    assert.deepEqual((['ready_to_connect', 'connecting', 'connected'] as const).map(isRelayLive), [true, true, true]);
    assert.equal(isRelayLive('preparing'), false);

    // 'unreachable' is a recoverable, non-terminal, stoppable state — not relay-live, not removable.
    assert.equal(isTerminal('unreachable'), false);
    assert.equal(isStoppable('unreachable'), true);
    assert.equal(isRelayLive('unreachable'), false);
    assert.equal(isCloseable('unreachable'), false); // must Stop, not Remove
});

test('unreachableStatus downgrades only monitorable-offline statuses; never a relay-live one', () => {
    for (const s of ['submitting', 'queued', 'preparing', 'disconnected', 'unreachable'] as const) {
        assert.equal(unreachableStatus(s), 'unreachable', `${s} should become unreachable`);
    }
    // Never downgrade a relay-live session for a monitoring-plane blip.
    for (const s of ['ready_to_connect', 'connecting', 'connected'] as const) {
        assert.equal(unreachableStatus(s), undefined, `${s} must not downgrade`);
    }
    // Terminal / not-yet-launched / launch-prompt states are left alone.
    for (const s of ['stopped', 'failed', 'completed', 'not_started', 'stopping', 'interrupted', 'awaiting_input'] as const) {
        assert.equal(unreachableStatus(s), undefined, `${s} must not downgrade`);
    }
});

test('isReattachable is non-terminal AND has persisted refs', () => {
    assert.equal(isReattachable('ready_to_connect', true), true);
    assert.equal(isReattachable('disconnected', true), true);
    assert.equal(isReattachable('unreachable', true), true);
    assert.equal(isReattachable('connected', true), true);
    assert.equal(isReattachable('ready_to_connect', false), false); // no refs → nothing to reattach to
    assert.equal(isReattachable('failed', true), false); // terminal
    assert.equal(isReattachable('completed', true), false);
    assert.equal(isReattachable('not_started', true), true); // non-terminal; refs-gate is the real guard
});

test('unreachable status climbs back to preparing on a successful RUNNING poll', () => {
    assert.deepEqual(computeStatusTransition('unreachable', SlurmJobStatus.RUNNING), { next: 'preparing' });
    assert.deepEqual(computeStatusTransition('unreachable', SlurmJobStatus.PENDING), { next: 'queued' });
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

test('UNKNOWN holds (never terminalizes) — a transient/unrecognized sacct state is not job death', () => {
    // PREEMPTED/REQUEUED/SUSPENDED/COMPLETING/blank rows all parse to UNKNOWN; none mean the job died.
    assert.deepEqual(computeStatusTransition('preparing', SlurmJobStatus.UNKNOWN), {});
    assert.deepEqual(computeStatusTransition('connected', SlurmJobStatus.UNKNOWN), {});
});

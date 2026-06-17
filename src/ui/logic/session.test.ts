import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmSession, ViewSession } from '@/models';
import { wallMs, fmtTime, remainingMs, dotColor, sessionActions, statusDescriptor } from './session';

test('wallMs parses HH:MM:SS to milliseconds', () => {
    assert.equal(wallMs('01:30:00'), 5_400_000);
    assert.equal(wallMs('00:00:45'), 45_000);
    assert.equal(wallMs(''), 0);
});

test('fmtTime shows h+m above an hour, m+s below', () => {
    assert.equal(fmtTime(5_400_000), '1h 30m');
    assert.equal(fmtTime(45_000), '0m 45s');
    assert.equal(fmtTime(-10), '0m 0s'); // clamps negatives
});

test('remainingMs counts down from startedAt, else returns the full wall time', () => {
    assert.equal(remainingMs({ wallTime: '01:00:00', startedAt: 1_000 }, 1_000), 3_600_000);
    assert.equal(remainingMs({ wallTime: '01:00:00', startedAt: 1_000 }, 601_000), 3_000_000);
    assert.equal(remainingMs({ wallTime: '01:00:00', startedAt: undefined }, 999_999), 3_600_000);
});

function sess(status: SlurmSession['status'], extra: Partial<SlurmSession & { isCurrent: boolean; windowAlive: boolean }> = {}) {
    return { status, ...extra } as ViewSession;
}

test('dotColor buckets statuses into idle/activating/live/failed colours', () => {
    assert.equal(dotColor('failed'), 'var(--vscode-errorForeground)');
    assert.equal(dotColor('stopped'), 'var(--vscode-errorForeground)');
    assert.equal(dotColor('queued'), 'var(--vscode-charts-yellow)');
    assert.equal(dotColor('submitting'), 'var(--vscode-charts-yellow)');
    assert.equal(dotColor('preparing'), 'var(--vscode-charts-green)');
    assert.equal(dotColor('connected'), 'var(--vscode-charts-green)');
    assert.equal(dotColor('completed'), 'var(--vscode-descriptionForeground)');
    assert.equal(dotColor('not_started'), 'var(--vscode-descriptionForeground)');
    assert.equal(dotColor('awaiting_input'), 'var(--vscode-charts-yellow)'); // same spinner-yellow as submitting; only the text changes
    assert.equal(dotColor('interrupted'), 'var(--vscode-descriptionForeground)'); // neutral resting state
});

test('sessionActions returns the right buttons per status', () => {
    assert.deepEqual(sessionActions(sess('not_started')).map(a => a.kind), ['start']);
    assert.deepEqual(sessionActions(sess('failed')).map(a => a.kind), ['restart']);
    assert.deepEqual(sessionActions(sess('preparing')).map(a => a.kind), ['stop']);
    assert.deepEqual(sessionActions(sess('ready_to_connect')).map(a => a.kind), ['stop', 'connect']);
    assert.deepEqual(sessionActions(sess('disconnected')).map(a => a.kind), ['stop', 'connect']);
    assert.deepEqual(sessionActions(sess('stopped')).map(a => a.kind), ['restart']);
    assert.deepEqual(sessionActions(sess('stopping')).map(a => a.kind), []); // stop in flight: spinner only, no Stop button
    assert.deepEqual(sessionActions(sess('awaiting_input')).map(a => a.kind), []); // the input box is the action
    const retry = sessionActions(sess('interrupted'));
    assert.deepEqual(retry.map(a => a.kind), ['restart']);
    assert.equal(retry[0].label, 'Retry');
});

test('connected session: Current when this window, else Switch/Connect by window liveness', () => {
    assert.deepEqual(sessionActions(sess('connected', { isCurrent: true })).map(a => a.kind), ['stop', 'current']);
    const switchBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: true }))[1];
    assert.equal(switchBtn.label, 'Switch');
    const connectBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: false }))[1];
    assert.equal(connectBtn.label, 'Connect');
});

test('statusDescriptor reports closeability', () => {
    assert.equal(statusDescriptor(sess('completed')).canClose, true);
    assert.equal(statusDescriptor(sess('preparing')).canClose, false);
});

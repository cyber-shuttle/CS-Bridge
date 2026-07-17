import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmSession, ViewSession } from '@/models';
import { wallMs, fmtTime, remainingMs, elapsedRunMs, elapsedLabel, dotColor, sessionActions, statusDescriptor } from './session';

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

test('elapsedLabel formats seconds-since, clamping a webview clock momentarily behind the timestamp to zero', () => {
    assert.equal(elapsedLabel(1_000, 6_000), '5s');
    assert.equal(elapsedLabel(1_000, 1_000), '0s');
    assert.equal(elapsedLabel(1_000, 126_000), '2m 5s'); // 125s
    assert.equal(elapsedLabel(1_000, 61_000), '1m 0s'); // exactly a minute
    assert.equal(elapsedLabel(5_000, 4_700), '0s'); // now 300ms behind submittedAt → never "-1s"
});

test('remainingMs counts down from startedAt, else returns the full wall time', () => {
    assert.equal(remainingMs({ wallTime: '01:00:00', startedAt: 1_000 }, 1_000), 3_600_000);
    assert.equal(remainingMs({ wallTime: '01:00:00', startedAt: 1_000 }, 601_000), 3_000_000);
    assert.equal(remainingMs({ wallTime: '01:00:00', startedAt: undefined }, 999_999), 3_600_000);
});

test('elapsedRunMs is elapsed-since-start, capped at the wall limit, 0 before start', () => {
    assert.equal(elapsedRunMs({ wallTime: '01:00:00', startedAt: 1_000 }, 601_000), 600_000); // mid-run: 10 min in
    assert.equal(elapsedRunMs({ wallTime: '01:00:00', startedAt: 1_000 }, 99_999_999), 3_600_000); // past deadline → capped at the 1h limit
    assert.equal(elapsedRunMs({ wallTime: '01:00:00', startedAt: undefined }, 601_000), 0); // not started yet
    assert.equal(elapsedRunMs({ wallTime: '', startedAt: 1_000 }, 601_000), 600_000); // no limit → uncapped
    assert.equal(elapsedRunMs({ wallTime: '01:00:00', startedAt: 5_000 }, 4_000), 0); // clamps a clock momentarily behind startedAt
});

function sess(status: SlurmSession['status'], extra: Partial<ViewSession> = {}) {
    return { status, ...extra } as ViewSession;
}

test('dotColor: orange for attention, green for live relay, grey for everything else', () => {
    assert.equal(dotColor('failed'), 'var(--vscode-charts-orange)');
    assert.equal(dotColor('unreachable'), 'var(--vscode-charts-orange)');
    assert.equal(dotColor('connecting'), 'var(--vscode-charts-green)');
    assert.equal(dotColor('connected'), 'var(--vscode-charts-green)');
    for (const s of ['not_started', 'submitting', 'queued', 'preparing', 'ready_to_connect', 'stopping', 'stopped', 'awaiting_input'] as const) {
        assert.equal(dotColor(s), 'var(--vscode-descriptionForeground)', `${s} should be grey`);
    }
});

test('sessionActions returns the right buttons per status', () => {
    assert.deepEqual(sessionActions(sess('not_started')).map(a => a.kind), ['start']);
    assert.deepEqual(sessionActions(sess('failed')).map(a => a.kind), ['restart']);
    assert.deepEqual(sessionActions(sess('preparing')).map(a => a.kind), ['stop']);
    assert.deepEqual(sessionActions(sess('ready_to_connect')).map(a => a.kind), ['stop', 'connect']);
    assert.deepEqual(sessionActions(sess('unreachable')).map(a => a.kind), ['stop', 'connect']);
    assert.equal(sessionActions(sess('unreachable'))[1].label, 'Reconnect'); // Connect rebuilds the relay → off the login node
    assert.deepEqual(sessionActions(sess('stopped')).map(a => a.kind), ['restart']);
    assert.deepEqual(sessionActions(sess('stopping')).map(a => a.kind), []); // stop in flight: spinner only, no Stop button
    assert.deepEqual(sessionActions(sess('awaiting_input')).map(a => a.kind), []); // the input box is the action
});

test('connected session: Current when this window, else Switch/Connect by window liveness', () => {
    assert.deepEqual(sessionActions(sess('connected', { isCurrent: true })).map(a => a.kind), ['stop', 'current']);
    const switchBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: true }))[1];
    assert.equal(switchBtn.label, 'Switch');
    const connectBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: false }))[1];
    assert.equal(connectBtn.label, 'Connect');
    const openingBtn = sessionActions(sess('connected', { isCurrent: false, windowAlive: false, opening: true }))[1];
    assert.deepEqual([openingBtn.kind, openingBtn.label], ['opening', 'Opening…']);
    const connectingBtn = sessionActions(sess('connecting'))[1];
    assert.deepEqual([connectingBtn.kind, connectingBtn.label], ['opening', 'Connecting…']);
});

test('statusDescriptor reports closeability', () => {
    assert.equal(statusDescriptor(sess('stopped')).canClose, true);
    assert.equal(statusDescriptor(sess('preparing')).canClose, false);
});

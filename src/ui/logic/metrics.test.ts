import { test } from 'node:test';
import assert from 'node:assert/strict';
import { efficiencySeverity, fmtPct, groupRunsBySession } from './metrics';

test('efficiencySeverity buckets by waste threshold', () => {
    assert.equal(efficiencySeverity(90), 'good');
    assert.equal(efficiencySeverity(75), 'good');
    assert.equal(efficiencySeverity(50), 'ok');
    assert.equal(efficiencySeverity(40), 'ok');
    assert.equal(efficiencySeverity(10), 'poor');
    assert.equal(efficiencySeverity(undefined), 'unknown');
});

test('fmtPct rounds, and shows a dash when unknown', () => {
    assert.equal(fmtPct(47.2), '47%');
    assert.equal(fmtPct(undefined), '—');
});

test('groupRunsBySession buckets by session, preserving newest-first order across and within groups', () => {
    const runs = [
        { sessionId: 'A', sessionName: 'a', cluster: 'delta', jobId: '3', endedAt: 300 },
        { sessionId: 'B', sessionName: 'b', cluster: 'expanse', jobId: '2', endedAt: 250 },
        { sessionId: 'A', sessionName: 'a', cluster: 'delta', jobId: '1', endedAt: 100 },
    ] as unknown as Parameters<typeof groupRunsBySession>[0];
    const groups = groupRunsBySession(runs);
    assert.deepEqual(groups.map(g => g.sessionId), ['A', 'B']); // group order = each session's newest run
    assert.deepEqual(groups[0].runs.map(r => r.jobId), ['3', '1']); // within-group newest-first preserved
    assert.equal(groups[1].runs.length, 1);
});

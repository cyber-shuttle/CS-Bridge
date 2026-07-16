import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuCoreSeries, efficiencyColor, fmtPct, groupRunsBySession } from './metrics';

test('cpuCoreSeries derives cores-busy from cumulative usec across sample gaps', () => {
    // 10s wall gaps (dt=1e7 usec). +1e7 usec/gap → 1.0 core; +2e7 → 2.0 cores.
    const samples = [
        { atMs: 0, cpuUsageUsec: 0 },
        { atMs: 10_000, cpuUsageUsec: 10_000_000 },
        { atMs: 20_000, cpuUsageUsec: 30_000_000 },
    ];
    assert.deepEqual(cpuCoreSeries(samples), [1, 2]);
});

test('cpuCoreSeries skips gaps with a missing reading or non-advancing clock', () => {
    const samples = [
        { atMs: 0, cpuUsageUsec: 0 },
        { atMs: 10_000 }, // missing reading → gap dropped
        { atMs: 20_000, cpuUsageUsec: 20_000_000 },
        { atMs: 20_000, cpuUsageUsec: 25_000_000 }, // dt=0 → dropped
    ];
    assert.deepEqual(cpuCoreSeries(samples), []);
});

test('efficiencyColor buckets by waste threshold', () => {
    const green = 'var(--vscode-charts-green)', yellow = 'var(--vscode-charts-yellow)';
    const red = 'var(--vscode-errorForeground)', grey = 'var(--vscode-descriptionForeground)';
    assert.equal(efficiencyColor(90), green);
    assert.equal(efficiencyColor(75), green);
    assert.equal(efficiencyColor(50), yellow);
    assert.equal(efficiencyColor(40), yellow);
    assert.equal(efficiencyColor(10), red);
    assert.equal(efficiencyColor(undefined), grey);
});

test('fmtPct rounds, and shows a dash when unknown', () => {
    assert.equal(fmtPct(47.2), '47%');
    assert.equal(fmtPct(undefined), '—');
});

test('groupRunsBySession buckets by session, preserving newest-first order across and within groups', () => {
    const runs = [
        { sessionId: 'A', cluster: 'delta', jobId: '3', endedAt: 300 },
        { sessionId: 'B', cluster: 'expanse', jobId: '2', endedAt: 250 },
        { sessionId: 'A', cluster: 'delta', jobId: '1', endedAt: 100 },
    ] as unknown as Parameters<typeof groupRunsBySession>[0];
    const groups = groupRunsBySession(runs);
    assert.deepEqual(groups.map(g => g[0].sessionId), ['A', 'B']); // group order = each session's newest run
    assert.deepEqual(groups[0].map(r => r.jobId), ['3', '1']); // within-group newest-first preserved
    assert.equal(groups[1].length, 1);
});

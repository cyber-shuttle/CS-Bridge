import { test } from 'node:test';
import assert from 'node:assert/strict';
import { efficiencySeverity, fmtPct } from './metrics';

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

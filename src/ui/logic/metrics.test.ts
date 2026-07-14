import { test } from 'node:test';
import assert from 'node:assert/strict';
import { efficiencyColor, fmtPct } from './metrics';

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

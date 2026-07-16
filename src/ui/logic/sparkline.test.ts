import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparklinePoints } from './sparkline';

test('sparklinePoints spreads x evenly and puts the max at the top (y=0)', () => {
    // values 0,50,100 over a 100×10 box → x at 0,50,100; max(100)→y0, min(0)→y10, mid→y5.
    assert.equal(sparklinePoints([0, 50, 100], 100, 10), '0,10 50,5 100,0');
});

test('sparklinePoints draws a flat series down the middle, not on the baseline', () => {
    assert.equal(sparklinePoints([7, 7, 7], 100, 10), '0,5 50,5 100,5');
});

test('sparklinePoints handles a single point', () => {
    assert.equal(sparklinePoints([42], 100, 10), '0,5');
});

test('sparklinePoints fills a fixed slot grid left-to-right, not spread to full width', () => {
    // 2 values in a 10-slot grid over width 90 → stepX = 90/9 = 10; points sit at x=0,10 (left), not 0,90.
    assert.equal(sparklinePoints([0, 100], 90, 10, undefined, 10), '0,10 10,0');
});

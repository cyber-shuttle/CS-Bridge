import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlurmClusterInfo, SlurmPartitionInfo } from '@/models';
import { partitionsForTab, hasTab, cpuOptions, memoryOptions, gpuOptions, gpuString, parseGpuClass } from './cluster';

const cpuPart: SlurmPartitionInfo = { name: 'cpu', cpuCount: 3, memory: '8192', gres: [] };
const gpuPart: SlurmPartitionInfo = { name: 'gpu', cpuCount: 16, memory: '0', gres: [{ name: 'a100', count: 2 }] };
const info: SlurmClusterInfo = { host: 'h', accounts: ['acct'], partitions: [cpuPart, gpuPart] };

test('partitionsForTab splits by presence of gres', () => {
    assert.deepEqual(partitionsForTab(info, 'cpu'), [cpuPart]);
    assert.deepEqual(partitionsForTab(info, 'gpu'), [gpuPart]);
    assert.equal(hasTab(info, 'gpu'), true);
    assert.equal(hasTab({ ...info, partitions: [cpuPart] }, 'gpu'), false);
});

test('cpuOptions lists 1..cpuCount', () => {
    assert.deepEqual(cpuOptions(cpuPart), [1, 2, 3]);
    assert.deepEqual(cpuOptions(undefined), []);
});

test('memoryOptions caps GB steps at the partition memory, falls back when unknown', () => {
    assert.deepEqual(memoryOptions(cpuPart), ['1 GB', '2 GB', '4 GB', '8 GB']); // 8192 MB → 8 GB
    assert.deepEqual(memoryOptions(gpuPart), ['1 GB', '2 GB', '4 GB', '8 GB', '16 GB', '32 GB', '64 GB', '128 GB']); // 0 → fallback
});

test('gpuOptions only yields counts/types on the gpu tab', () => {
    assert.deepEqual(gpuOptions(gpuPart, 'gpu'), { counts: [1, 2], types: ['a100'] });
    assert.deepEqual(gpuOptions(gpuPart, 'cpu'), { counts: [], types: [] });
    assert.deepEqual(gpuOptions(cpuPart, 'gpu'), { counts: [], types: [] });
});

test('gpuString assembles the SLURM gres value', () => {
    assert.equal(gpuString('a100', 2), 'a100:2');
    assert.equal(gpuString('', 2), '2');
    assert.equal(gpuString('a100', 0), 'None');
});

test('parseGpuClass inverts gpuString, splitting the count off the LAST colon (gres names contain colons)', () => {
    // The edit-form prefill bug: a gres name like "gpu:a100" itself has a colon, so the count is the final segment.
    assert.deepEqual(parseGpuClass('gpu:a100:2'), { gpuType: 'gpu:a100', gpuCount: '2' });
    assert.deepEqual(parseGpuClass('a100:2'), { gpuType: 'a100', gpuCount: '2' });
    assert.deepEqual(parseGpuClass('2'), { gpuType: '', gpuCount: '2' }); // gpuString('', n) form
    assert.equal(parseGpuClass('None'), undefined);
    assert.equal(parseGpuClass(''), undefined);
    // Round-trips for a colon-containing type.
    assert.deepEqual(parseGpuClass(gpuString('gpu:a100', 4)), { gpuType: 'gpu:a100', gpuCount: '4' });
});

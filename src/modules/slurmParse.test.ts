import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartitionLine, generateSlurmScript } from './slurmParse';
import { SlurmSession, TunnelCredential } from '../models';

test('parsePartitionLine strips the default-partition marker and parses "24+" CPUs', () => {
    assert.deepEqual(parsePartitionLine('cpu-small*|24+|191000+|(null)'), {
        name: 'cpu-small', cpuCount: 24, memory: '191000+', gres: [],
    });
});

test('parsePartitionLine parses a GPU GRES entry with socket suffix', () => {
    assert.deepEqual(parsePartitionLine('interactive-cpu|24|191000+|gpu:v100:2(S:0-1)'), {
        name: 'interactive-cpu', cpuCount: 24, memory: '191000+', gres: [{ name: 'gpu:v100', count: 2 }],
    });
});

test('parsePartitionLine splits multiple comma-separated GRES at the top level only', () => {
    const p = parsePartitionLine('big|128|515000|gpu:a100:2(S:2,5),gpu:v100:4');
    assert.deepEqual(p.gres, [{ name: 'gpu:a100', count: 2 }, { name: 'gpu:v100', count: 4 }]);
});

test('parsePartitionLine throws on a malformed line', () => {
    assert.throws(() => parsePartitionLine('only|three|fields'), /Invalid sinfo line/);
});

test('generateSlurmScript emits the resource #SBATCH directives and the linkspan invocation', () => {
    const session = {
        cpus: 4, memory: '8 GB', wallTime: '02:00:00', queue: 'gpu', allocation: 'acct1',
        gpuClass: 'a100', gpuCount: 1, tunnelId: 'tid', tunnelCluster: 'use',
    } as SlurmSession;
    const cred = { provider: 'devtunnel', authToken: 'tok' } as TunnelCredential;
    const script = generateSlurmScript(session, cred);
    assert.match(script, /^#SBATCH --cpus-per-task=4$/m);
    assert.match(script, /^#SBATCH --mem=8GB$/m);
    assert.match(script, /^#SBATCH --partition=gpu$/m);
    assert.match(script, /^#SBATCH --gres=gpu:a100$/m);
    assert.match(script, /--tunnel-auth-token 'tok' --tunnel-id 'tid' --tunnel-cluster 'use' -tunnel-enable/);
});

test('generateSlurmScript omits the GPU directive when no GPU is selected', () => {
    const session = {
        cpus: 2, memory: '4 GB', wallTime: '01:00:00', queue: 'cpu', allocation: 'acct1',
        gpuClass: '', gpuCount: 0,
    } as SlurmSession;
    const script = generateSlurmScript(session, { provider: 'devtunnel', authToken: 't' } as TunnelCredential);
    assert.doesNotMatch(script, /--gres=/);
});

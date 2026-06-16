import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartitionLine, buildSlurmScript, parseSacctStatus } from './slurmParse';
import { SlurmJobStatus, SlurmSession, TunnelCredential } from '../models';

test('parseSacctStatus classifies each SLURM state and reads ElapsedRaw', () => {
    assert.deepEqual(parseSacctStatus('FAILED|1:0|None|120'), { status: SlurmJobStatus.FAILED, elapsedSec: 120 });
    assert.deepEqual(parseSacctStatus('CANCELLED by 1001|0:0|None|0'), { status: SlurmJobStatus.CANCELLED, elapsedSec: 0 });
    assert.deepEqual(parseSacctStatus('RUNNING|0:0|None|345'), { status: SlurmJobStatus.RUNNING, elapsedSec: 345 });
    assert.deepEqual(parseSacctStatus('TIMEOUT|0:0|None|3600'), { status: SlurmJobStatus.TIMEOUT, elapsedSec: 3600 });
    assert.equal(parseSacctStatus('OUT_OF_MEMORY|0:0|None|5').status, SlurmJobStatus.OUT_OF_MEMORY);
    assert.equal(parseSacctStatus('COMPLETED|0:0|None|5').status, SlurmJobStatus.COMPLETED);
    assert.equal(parseSacctStatus('PENDING|0:0|Priority|0').status, SlurmJobStatus.PENDING);
});

test('parseSacctStatus returns UNKNOWN for an unrecognized state and 0 elapsed for non-numeric', () => {
    assert.deepEqual(parseSacctStatus('SOMETHING_ELSE|0:0|None|n/a'), { status: SlurmJobStatus.UNKNOWN, elapsedSec: 0 });
});

test('parseSacctStatus throws on empty or malformed output', () => {
    assert.throws(() => parseSacctStatus(''), /No output from sacct/);
    assert.throws(() => parseSacctStatus('FAILED|1:0'), /Unexpected output format/);
});

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

test('buildSlurmScript emits the resource #SBATCH directives and the linkspan invocation', () => {
    const session = {
        cpus: 4, memory: '8 GB', wallTime: '02:00:00', queue: 'gpu', allocation: 'acct1',
        gpuClass: 'a100', gpuCount: 1, tunnelId: 'tid', tunnelCluster: 'use',
    } as SlurmSession;
    const cred = { provider: 'devtunnel', authToken: 'tok' } as TunnelCredential;
    const script = buildSlurmScript(session, cred);
    assert.match(script, /^#SBATCH --cpus-per-task=4$/m);
    assert.match(script, /^#SBATCH --mem=8GB$/m);
    assert.match(script, /^#SBATCH --partition=gpu$/m);
    assert.match(script, /^#SBATCH --gres=gpu:a100$/m);
    assert.match(script, /--tunnel-auth-token 'tok' --tunnel-id 'tid' --tunnel-cluster 'use' -tunnel-enable/);
});

test('buildSlurmScript omits the GPU directive when no GPU is selected', () => {
    const session = {
        cpus: 2, memory: '4 GB', wallTime: '01:00:00', queue: 'cpu', allocation: 'acct1',
        gpuClass: '', gpuCount: 0,
    } as SlurmSession;
    const script = buildSlurmScript(session, { provider: 'devtunnel', authToken: 't' } as TunnelCredential);
    assert.doesNotMatch(script, /--gres=/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartitionLine, buildSlurmScript, parseSacctStatus, parseSacctUtil } from './slurmParse';
import { SlurmJobStatus, SlurmSession, TunnelCredential } from '../models';

test('parseSacctStatus classifies each SLURM state and reads ElapsedRaw', () => {
    assert.deepEqual(parseSacctStatus('FAILED|1:0|None|120'), { status: SlurmJobStatus.FAILED, elapsedSec: 120 });
    assert.deepEqual(parseSacctStatus('CANCELLED by 1001|0:0|None|0'), { status: SlurmJobStatus.CANCELLED, elapsedSec: 0 });
    assert.deepEqual(parseSacctStatus('RUNNING|0:0|None|345'), { status: SlurmJobStatus.RUNNING, elapsedSec: 345 });
    assert.deepEqual(parseSacctStatus('TIMEOUT|0:0|None|3600'), { status: SlurmJobStatus.TIMEOUT, elapsedSec: 3600 });
    assert.equal(parseSacctStatus('OUT_OF_MEMORY|0:0|None|5').status, SlurmJobStatus.OUT_OF_MEMORY);
    assert.equal(parseSacctStatus('COMPLETED|0:0|None|5').status, SlurmJobStatus.COMPLETED);
    assert.equal(parseSacctStatus('PENDING|0:0|Priority|0').status, SlurmJobStatus.QUEUED);
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
        gpuClass: 'gpu:a100', gpuCount: 1, tunnelId: 'tid', tunnelCluster: 'use',
        connectionInfo: { apiPort: 25000, sshPort: 0, sshTunnelId: '', region: '' },
    } as SlurmSession;
    const cred = { provider: 'devtunnel', authToken: 'tok' } as TunnelCredential;
    const script = buildSlurmScript(session, cred);
    assert.match(script, /^#SBATCH --nodes=1$/m);
    assert.match(script, /^#SBATCH --cpus-per-task=4$/m);
    assert.match(script, /^#SBATCH --mem=8GB$/m);
    assert.match(script, /^#SBATCH --partition=gpu$/m);
    assert.match(script, /^#SBATCH --account=acct1$/m);
    assert.match(script, /^#SBATCH --gres=gpu:a100$/m);
    // linkspan binds the port csbridge pinned at launch, so csbridge knows the tunnel URL without discovery.
    assert.match(script, /--port 25000 --tunnel-auth-token 'tok' --tunnel-id 'tid' --tunnel-cluster 'use' -tunnel-enable/);
});

test('buildSlurmScript omits the GPU directive when no GPU is selected', () => {
    const session = {
        cpus: 2, memory: '4 GB', wallTime: '01:00:00', queue: 'cpu', allocation: 'acct1',
        gpuClass: '', gpuCount: 0,
    } as SlurmSession;
    const script = buildSlurmScript(session, { provider: 'devtunnel', authToken: 't' } as TunnelCredential);
    assert.doesNotMatch(script, /--gres=/);
});

test('buildSlurmScript omits the account directive when no allocation is selected', () => {
    const session = {
        cpus: 2, memory: '4 GB', wallTime: '01:00:00', queue: 'debug', allocation: '',
        gpuClass: '', gpuCount: 0,
    } as SlurmSession;
    const script = buildSlurmScript(session, { provider: 'devtunnel', authToken: 't' } as TunnelCredential);
    assert.doesNotMatch(script, /--account/); // a blank --account= is rejected by SLURM
});

test('parseSacctUtil reads allocation fields, ignoring the empty usage on the main row', () => {
    const out = '20041571|2|2097152K|1573|3146||';
    assert.deepEqual(parseSacctUtil(out), { cores: 2, reqMem: '2.0 GB', elapsedSec: 1573 });
});

test('parseSacctUtil derives CPU and memory efficiency from the batch step usage', () => {
    const out = [
        '20041571|2|2097152K|1573|3146||',
        '20041571.batch|2|2097152K|1573|3146|1048576K|00:26:00',
    ].join('\n');
    const m = parseSacctUtil(out);
    assert.equal(m.cores, 2);
    assert.equal(m.elapsedSec, 1573);
    assert.equal(m.maxRss, '1.0 GB'); // 1048576K = 1 GiB
    assert.equal(Math.round(m.memEfficiencyPct!), 50); // 1 GiB used / 2 GiB requested
    assert.equal(Math.round(m.cpuEfficiencyPct!), 50); // 1560s used / 3146s allocated = 49.6%
});

test('parseSacctUtil derives efficiency across a day-spanning TotalCPU', () => {
    const out = '55|4|4194304K|86400|345600||\n55.batch|4|4194304K|86400|345600|2097152K|1-00:00:00';
    const m = parseSacctUtil(out);
    assert.equal(Math.round(m.memEfficiencyPct!), 50); // 2 GiB used / 4 GiB requested
    assert.equal(Math.round(m.cpuEfficiencyPct!), 25); // 86400s used / 345600s allocated = 25%
});

test('parseSacctUtil ignores srun poll steps and the empty running batch (no efficiency until it flushes)', () => {
    const out = [
        '20240108|2|2097152K|1641|3282||00:00:00',
        '20240108.batch|2||1641|3282||00:00:00', // batch usage not flushed yet
        '20240108.extern|2||1641|3282||00:00:00',
        '20240108.0|2||1|2|24K|00:00:00', // our srun metric-poll steps — tiny, must not be read
        '20240108.77|2||0|0|64K|00:00:00',
    ].join('\n');
    assert.deepEqual(parseSacctUtil(out), { cores: 2, reqMem: '2.0 GB', elapsedSec: 1641 });
});

test('parseSacctUtil returns an empty object for no output', () => {
    assert.deepEqual(parseSacctUtil(''), {});
});

test('buildSlurmScript unsets the inherited XDG_RUNTIME_DIR/TMPDIR before launching linkspan', () => {
    const session = {
        cpus: 2, memory: '4 GB', wallTime: '01:00:00', queue: 'cpu', allocation: 'acct1',
        gpuClass: '', gpuCount: 0,
    } as SlurmSession;
    const script = buildSlurmScript(session, { provider: 'devtunnel', authToken: 't' } as TunnelCredential);

    // The compute node has no logind, so the inherited /run/user/<uid> XDG_RUNTIME_DIR is absent there;
    // unset it (and TMPDIR) so the VS Code server falls back to its node-local /tmp default.
    assert.match(script, /^unset XDG_RUNTIME_DIR TMPDIR$/m);

    // linkspan must inherit the cleaned env, so the unset has to precede its invocation.
    assert.ok(script.indexOf('unset XDG_RUNTIME_DIR') < script.indexOf('--tunnel-auth-token'),
        'unset precedes linkspan invocation');
});

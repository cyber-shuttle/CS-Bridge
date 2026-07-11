import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlurmAvailability, checkLinkspanInstallation, installLinkspan, submitJobToSlurm, validateSlurmConfig, RemoteRunner } from './slurmLaunch';
import { SlurmSession } from '../models';

const noopLog = { info() {}, warn() {}, error() {} };
const session = (over: Partial<SlurmSession> = {}) => ({ cluster: 'cl', name: 's', ...over }) as SlurmSession;

// A fake runner that returns scripted results per command substring, in order of the rules given.
function runner(rules: Array<{ match: string; stdout?: string; stderr?: string; code?: number }>): RemoteRunner {
    return {
        async runRemoteCommand(_host, command) {
            const r = rules.find(x => command.includes(x.match));
            if (!r) { throw new Error(`unexpected command: ${command}`); }
            return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 };
        },
    };
}

test('checkSlurmAvailability resolves when sinfo exits 0 and throws otherwise', async () => {
    await checkSlurmAvailability(session(), runner([{ match: 'sinfo', code: 0 }]), noopLog);
    await assert.rejects(
        () => checkSlurmAvailability(session(), runner([{ match: 'sinfo', code: 1, stderr: 'down' }]), noopLog),
        /Slurm is not available on cluster cl: down/);
});

test('checkLinkspanInstallation returns true only when local matches latest (v-prefix stripped)', async () => {
    const up = runner([{ match: 'releases/latest', stdout: 'v1.2.3' }, { match: '--version', stdout: '1.2.3' }]);
    assert.equal(await checkLinkspanInstallation(session(), up, noopLog), true);

    const stale = runner([{ match: 'releases/latest', stdout: 'v1.2.4' }, { match: '--version', stdout: '1.2.3' }]);
    assert.equal(await checkLinkspanInstallation(session(), stale, noopLog), false);

    const missing = runner([{ match: 'releases/latest', stdout: 'v1.2.3' }, { match: '--version', stdout: '' }]);
    assert.equal(await checkLinkspanInstallation(session(), missing, noopLog), false);
});

test('installLinkspan normalizes aarch64 and throws on a failed install', async () => {
    const calls: string[] = [];
    const run: RemoteRunner = {
        async runRemoteCommand(_h, command) {
            calls.push(command);
            if (command.includes('uname')) { return { stdout: 'aarch64', stderr: '', code: 0 }; }
            return { stdout: 'ok', stderr: '', code: 0 };
        },
    };
    await installLinkspan(session(), run, noopLog);
    assert.ok(calls.some(c => c.includes('linkspan_Linux_arm64.tar.gz')), 'aarch64 should map to arm64 asset');

    await assert.rejects(
        () => installLinkspan(session(), runner([{ match: 'uname', stdout: 'x86_64' }, { match: 'curl', code: 1, stderr: 'net' }]), noopLog),
        /Failed to install Linkspan on cluster cl: net/);
});

test('validateSlurmConfig resolves on exit 0 and throws the site filter error otherwise', async () => {
    const s = session({ cpus: 2, memory: '2 GB', wallTime: '00:30:00', queue: 'skx-dev', allocation: 'acct1', gpuClass: '', gpuCount: 0 });
    await validateSlurmConfig(s, runner([{ match: 'sbatch --test-only', stderr: 'sbatch: Job 1 to start at ...' }]), noopLog);
    await assert.rejects(
        () => validateSlurmConfig(s, runner([{ match: 'sbatch --test-only', code: 1, stderr: 'ERROR: Unknown project acct1' }]), noopLog),
        /Cluster cl rejected the session configuration: ERROR: Unknown project acct1/);
});

test('submitJobToSlurm sets jobId + queued on success and throws on missing script / bad output', async () => {
    const s = session({ batchScript: '#!/bin/bash' });
    await submitJobToSlurm(s, runner([{ match: 'sbatch', stdout: 'Submitted batch job 4242' }]), noopLog);
    assert.equal(s.jobId, '4242');
    assert.equal(s.status, 'queued');
    assert.ok((s.submittedAt ?? 0) > 0);

    await assert.rejects(() => submitJobToSlurm(session(), runner([]), noopLog), /missing batch script/);
    await assert.rejects(
        () => submitJobToSlurm(session({ batchScript: 'x' }), runner([{ match: 'sbatch', stdout: 'no id here' }]), noopLog),
        /Failed to parse job ID/);
});

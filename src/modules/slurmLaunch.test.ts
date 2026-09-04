import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkspanInstallation, keepsInstalledLinkspan, installLinkspan, submitJobToSlurm, validateSlurmConfig, RemoteRunner } from './slurmLaunch';
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

// A runner that records every command it is given, answering `uname` with machine.
function recordingRunner(machine: string): { run: RemoteRunner; calls: string[] } {
    const calls: string[] = [];
    const run: RemoteRunner = {
        async runRemoteCommand(_h, command) {
            calls.push(command);
            return { stdout: command.includes('uname') ? machine : 'ok', stderr: '', code: 0 };
        },
    };
    return { run, calls };
}

test('keepsInstalledLinkspan keeps only a real version that is ahead of the release', () => {
    assert.equal(keepsInstalledLinkspan('0.15.13', '0.15.12'), true);
    assert.equal(keepsInstalledLinkspan('0.15.12', '0.15.12'), true); // already installed
    assert.equal(keepsInstalledLinkspan('0.15.11', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('0.9.0', '0.15.0'), false); // numbers, not strings
    // A build ahead of a release outranks older releases and yields to its own.
    assert.equal(keepsInstalledLinkspan('0.16.0.1ebf666', '0.15.12'), true);
    assert.equal(keepsInstalledLinkspan('0.16.0.1ebf666', '0.16.0'), false);
    assert.equal(keepsInstalledLinkspan('0.17.0.1ebf666', '0.16.0'), true);
    assert.equal(keepsInstalledLinkspan('0.16.0', '0.16.0.aaaaaaa'), true); // a release never carries a commit
    // Only X.Y.Z[.commit] is a version; anything else must never outrank a release.
    assert.equal(keepsInstalledLinkspan('dev', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('0.15.12-1-g1ee565a', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('', '0.15.12'), false);
    assert.equal(keepsInstalledLinkspan('0.15.12', ''), true); // no answer about the latest keeps what works
});

test('checkLinkspanInstallation passes the installed and latest versions the right way round', async () => {
    const ahead = runner([{ match: 'releases/latest', stdout: 'v1.2.3' }, { match: '--version', stdout: '1.2.4' }]);
    assert.equal(await checkLinkspanInstallation(session(), ahead, noopLog), true);

    const stale = runner([{ match: 'releases/latest', stdout: 'v1.2.4' }, { match: '--version', stdout: '1.2.3' }]);
    assert.equal(await checkLinkspanInstallation(session(), stale, noopLog), false);
});

test('installLinkspan normalizes aarch64 and throws on a failed install', async () => {
    const { run, calls } = recordingRunner('aarch64');
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

// cs-control's provisionScript refuses an unmapped machine by name (error=architecture).
// Building a release URL from it instead would 404 and read as a network fault.
test('installLinkspan refuses a machine linkspan is not released for', async () => {
    await assert.rejects(
        () => installLinkspan(session(), runner([{ match: 'uname', stdout: 'ppc64le' }]), noopLog),
        /architecture ppc64le, which Linkspan is not released for/);
});

// An interrupted download must not leave a truncated binary where the next launch execs it.
test('installLinkspan stages the download and moves it into place', async () => {
    const { run, calls } = recordingRunner('x86_64');
    await installLinkspan(session(), run, noopLog);
    const install = calls.find(c => c.includes('curl')) ?? '';
    assert.match(install, /staged=/, 'download must land on a staging path');
    assert.match(install, /mv -f "\$staged"/, 'the staged file must be moved into place, not written in place');
    assert.doesNotMatch(install, /tar -xz -C/, 'must not untar straight onto the destination');
    assert.match(install, /install -d -m 700/, 'the bin directory should be owner-only');
});

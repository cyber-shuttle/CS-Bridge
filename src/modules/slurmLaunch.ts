import { SlurmSession } from '../models';
import { buildSlurmScript } from './slurmParse';

// RemoteRunner/LogSink are injected (SshManager and Logger satisfy them structurally) so the steps below
// are unit-testable with fakes, free of SSH and vscode.
export interface RemoteRunner {
    runRemoteCommand(host: string, command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

interface LogSink {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

// Each step throws on failure and mutates only the in-memory session; the caller reports progress and persists.

type CommandResult = { stdout: string; stderr: string; code: number };

function ensureSuccess(result: CommandResult, failure: string): void {
    if (result.code !== 0) { throw new Error(`${failure}: ${result.stderr}`); }
}

export async function checkSlurmAvailability(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    const res = await run.runRemoteCommand(session.cluster, 'sinfo');
    ensureSuccess(res, `Slurm is not available on cluster ${session.cluster}`);
    log.info(`Slurm is available on cluster ${session.cluster}`);
}

// Newest wins, ties go to the release. A release is X.Y.Z; a build ahead of one is X.Y.Z.<commit>, so it yields
// once that release ships and never ties another build. Anything else is not a version. cs-control matches this.
const INSTALLED = /^(\d+)\.(\d+)\.(\d+)(\.[0-9a-f]{7,40})?$/;
const RELEASED = /^(\d+)\.(\d+)\.(\d+)$/;

export function keepsInstalledLinkspan(local: string, latest: string): boolean {
    const here = INSTALLED.exec(local);
    if (!here) { return false; }
    const there = RELEASED.exec(latest);
    if (!there) { return true; } // no answer about the latest; a working binary beats a guess
    for (let i = 1; i <= 3; i++) {
        if (Number(here[i]) !== Number(there[i])) { return Number(here[i]) > Number(there[i]); }
    }
    return !here[4];
}

// A version-check failure returns false (→ reinstall) rather than throwing, so it never fails the launch.
export async function linkspanIsUpToDate(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<boolean> {
    const remoteVersionResult = await run.runRemoteCommand(session.cluster, `curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | sed 's#.*/##'`);
    const localVersionResult = await run.runRemoteCommand(session.cluster, `~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo ""`);

    if (localVersionResult.code !== 0) {
        log.error(`Failed to check Linkspan version on cluster ${session.cluster}. Error: ${localVersionResult.stderr}`);
        return false;
    }

    const localVersion = localVersionResult.stdout.trim().replace(/^v/, '');
    // A failed lookup is no answer about the latest release, not proof there is none: keep what is installed.
    const remoteVersion = (remoteVersionResult.code === 0 ? remoteVersionResult.stdout.trim() : '').replace(/^v/, '');

    if (keepsInstalledLinkspan(localVersion, remoteVersion)) {
        log.info(`Linkspan ${localVersion} on cluster ${session.cluster} is at or ahead of the latest release (${remoteVersion || 'unknown'}); keeping it`);
        return true;
    }
    log.info(`Linkspan is not installed or outdated on cluster ${session.cluster}. Local version: ${localVersion}, Latest version: ${remoteVersion}`);
    return false;
}

// uname to the release asset. cs-control maps the same three machines in
// provisionScript and refuses anything else by name; an unmapped arch would
// otherwise build a URL that 404s, which reads as a network fault rather than
// as a machine Linkspan is not released for.
const RELEASE_ARCH: Readonly<Record<string, string>> = { x86_64: 'x86_64', aarch64: 'arm64', arm64: 'arm64' };

export async function installLinkspan(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    const archResult = await run.runRemoteCommand(session.cluster, 'uname -m');
    ensureSuccess(archResult, 'Failed to detect remote architecture');
    const machine = archResult.stdout.trim();
    const arch = RELEASE_ARCH[machine];
    if (!arch) {
        throw new Error(`Cluster ${session.cluster} reports architecture ${machine}, which Linkspan is not released for`);
    }
    log.info(`Detected architecture on cluster ${session.cluster}: ${machine}`);

    const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/linkspan_Linux_${arch}.tar.gz`;
    log.info(`Downloading Linkspan from ${downloadUrl} for architecture ${arch}`);
    // Staged and moved, so an interrupted download never becomes the binary a job
    // execs -- cs-control's provisionScript installs the same way. The directory
    // and the binary stay owner-only: nothing else on a shared login node needs them.
    const install = [
        'set -eu',
        'bin=$HOME/.cybershuttle/bin',
        'install -d -m 700 "$bin"',
        'staged=$bin/.linkspan.$$',
        'trap \'rm -f "$staged"\' EXIT',
        `curl -fsSL "${downloadUrl}" | tar -xzO linkspan > "$staged"`,
        '[ -s "$staged" ]',
        'chmod 700 "$staged"',
        'mv -f "$staged" "$bin/linkspan"',
    ].join('\n');
    const installB64 = Buffer.from(install).toString('base64');
    const installResult = await run.runRemoteCommand(session.cluster, `echo '${installB64}' | base64 -d | bash`);
    ensureSuccess(installResult, `Failed to install Linkspan on cluster ${session.cluster}`);
    log.info(`Linkspan installed successfully on cluster ${session.cluster}`);
}

// --test-only runs the site submit filter without queueing; the body never runs, so a blank credential is fine.
export async function validateSlurmConfig(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    const scriptB64 = Buffer.from(buildSlurmScript(session, '')).toString('base64');
    const result = await run.runRemoteCommand(session.cluster, `echo '${scriptB64}' | base64 -d | sbatch --test-only`);
    ensureSuccess(result, `Cluster ${session.cluster} rejected the session configuration`);
    log.info(`Cluster ${session.cluster} validated the session configuration: ${(result.stderr || result.stdout).trim()}`);
}

export async function submitJobToSlurm(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    if (!session.batchScript) { throw new Error(`Session ${session.name}: missing batch script`); }

    const scriptB64 = Buffer.from(session.batchScript).toString('base64');
    const submitCommand = `echo '${scriptB64}' | base64 -d | sbatch`;
    log.info(`Submitting job to Slurm with command: ${submitCommand}`);

    const submitResult = await run.runRemoteCommand(session.cluster, submitCommand);
    ensureSuccess(submitResult, 'Job submission failed');

    const output = submitResult.stdout.trim();
    log.info(`Job submission output: ${output}`);
    const jobIdMatch = output.match(/Submitted batch job (\d+)/);
    if (!jobIdMatch) { throw new Error(`Failed to parse job ID from sbatch output: ${output}`); }

    session.batchScript = undefined; // held the tunnel host token; sbatch has it now
    session.jobId = jobIdMatch[1];
    session.submittedAt = Date.now();
    log.info(`Job submitted successfully with Job ID: ${session.jobId}`);
}

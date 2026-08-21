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

// A Linkspan version is X.Y.Z for a release, or X.Y.Z.<commit> for a build made ahead
// of one; anything else does not count as a version, so an unversioned build cannot
// outrank every release forever.
const VERSION = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:\.([0-9a-f]{7,40}))?$/;

// Newest wins, and a tie goes to the release: a build carrying a version above the
// published one is left alone, while a release at the same numbers or higher replaces
// it. A build names the commit it came from, so two builds are never the same version
// and a newer one always replaces an older one. cs-control's installer follows the same
// rule, so neither can undo the other.
export function keepsInstalledLinkspan(local: string, latest: string): boolean {
    const here = VERSION.exec(local);
    if (!here) { return false; }
    const there = VERSION.exec(latest);
    if (!there) { return true; } // no answer about the release; a working binary beats a guess
    for (let i = 1; i <= 3; i++) {
        const [x, y] = [Number(here[i]), Number(there[i])];
        if (x !== y) { return x > y; }
    }
    return !here[4] && !!there[4]; // same numbers: only a release beats a build ahead of it
}

// A version-check failure returns false (→ reinstall) rather than throwing, so it never fails the launch.
export async function checkLinkspanInstallation(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<boolean> {
    const remoteVersionResult = await run.runRemoteCommand(session.cluster, `curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | grep -oP '[^/]+$'`);
    const localVersionResult = await run.runRemoteCommand(session.cluster, `~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo ""`);

    if (localVersionResult.code !== 0) {
        log.error(`Failed to check Linkspan version on cluster ${session.cluster}. Error: ${localVersionResult.stderr}`);
        return false;
    }

    const localVersion = localVersionResult.stdout.trim().replace(/^v/, '');
    // A failed lookup means no answer about the latest release, not that there isn't one:
    // an installed binary is kept rather than replaced by a download that just failed.
    const remoteTag = remoteVersionResult.code === 0 ? remoteVersionResult.stdout.trim() : '';
    const remoteVersion = remoteTag.startsWith('v') ? remoteTag.slice(1) : remoteTag;

    if (keepsInstalledLinkspan(localVersion, remoteVersion)) {
        log.info(`Linkspan ${localVersion} on cluster ${session.cluster} is at or ahead of the latest release (${remoteVersion || 'unknown'}); keeping it`);
        return true;
    }
    log.info(`Linkspan is not installed or outdated on cluster ${session.cluster}. Local version: ${localVersion}, Latest version: ${remoteVersion}`);
    return false;
}

export async function installLinkspan(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    const archResult = await run.runRemoteCommand(session.cluster, 'uname -m');
    ensureSuccess(archResult, 'Failed to detect remote architecture');
    let arch = archResult.stdout.trim();
    if (arch === 'aarch64') { arch = 'arm64'; }
    log.info(`Detected architecture on cluster ${session.cluster}: ${arch}`);

    const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/linkspan_Linux_${arch}.tar.gz`;
    log.info(`Downloading Linkspan from ${downloadUrl} for architecture ${arch}`);
    const installResult = await run.runRemoteCommand(session.cluster,
        `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`);
    ensureSuccess(installResult, `Failed to install Linkspan on cluster ${session.cluster}`);
    log.info(`Linkspan installed successfully on cluster ${session.cluster}`);
    log.info('Installation output:', installResult.stdout);
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
    const submitCommand = `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d | sbatch`;
    log.info(`Submitting job to Slurm with command: ${submitCommand}`);

    const submitResult = await run.runRemoteCommand(session.cluster, submitCommand);
    ensureSuccess(submitResult, 'Job submission failed');

    const output = submitResult.stdout.trim();
    log.info(`Job submission output: ${output}`);
    const jobIdMatch = output.match(/Submitted batch job (\d+)/);
    if (!jobIdMatch) { throw new Error(`Failed to parse job ID from sbatch output: ${output}`); }

    session.batchScript = undefined; // holds the tunnel host token; done with it once sbatch has taken it
    session.jobId = jobIdMatch[1];
    session.status = 'queued';
    session.submittedAt = Date.now();
    log.info(`Job submitted successfully with Job ID: ${session.jobId}`);
}

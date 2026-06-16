import { SlurmSession } from "../models";

// A remote command runner — SshManager satisfies this structurally. Injected so the launch steps are
// unit-testable with a fake runner, without SSH or vscode.
export interface RemoteRunner {
    runRemoteCommand(host: string, command: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

// Minimal logging sink — the Logger singleton satisfies this structurally; tests pass a no-op/capturing fake.
export interface LogSink {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

// Each step throws on failure and mutates only the in-memory session; the caller reports progress and persists.

export async function checkSlurmAvailability(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    const res = await run.runRemoteCommand(session.cluster, 'sinfo');
    if (res.code !== 0) {
        throw new Error(`Slurm is not available on cluster ${session.cluster}: ${res.stderr}`);
    }
    log.info(`Slurm is available on cluster ${session.cluster}`);
}

// Returns true when the installed linkspan matches the latest release. A version-check failure is treated as
// "not up to date" (returns false -> triggers install), not a launch failure.
export async function checkLinkspanInstallation(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<boolean> {
    const remoteVersionResult = await run.runRemoteCommand(session.cluster, `curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cyber-shuttle/linkspan/releases/latest 2>/dev/null | grep -oP '[^/]+$'`);
    const localVersionResult = await run.runRemoteCommand(session.cluster, `~/.cybershuttle/bin/linkspan --version 2>/dev/null || echo ""`);

    if (remoteVersionResult.code !== 0) {
        log.error(`Failed to check Linkspan latest version. Error: ${remoteVersionResult.stderr}`);
        return false;
    }
    if (localVersionResult.code !== 0) {
        log.error(`Failed to check Linkspan version on cluster ${session.cluster}. Error: ${localVersionResult.stderr}`);
        return false;
    }

    const localVersion = localVersionResult.stdout.trim();
    const remoteTag = remoteVersionResult.stdout.trim();
    const remoteVersion = remoteTag.startsWith('v') ? remoteTag.slice(1) : remoteTag;

    if (localVersion !== '' && remoteVersion !== '' && localVersion === remoteVersion) {
        log.info(`Linkspan is already installed and up to date on cluster ${session.cluster}`);
        return true;
    }
    log.info(`Linkspan is not installed or outdated on cluster ${session.cluster}. Local version: ${localVersion}, Latest version: ${remoteVersion}`);
    return false;
}

export async function installLinkspan(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    const archResult = await run.runRemoteCommand(session.cluster, 'uname -m');
    if (archResult.code !== 0) { throw new Error('Failed to detect remote architecture'); }
    let arch = archResult.stdout.trim();
    if (arch === 'aarch64') { arch = 'arm64'; }
    log.info(`Detected architecture on cluster ${session.cluster}: ${arch}`);

    const downloadUrl = `https://github.com/cyber-shuttle/linkspan/releases/latest/download/linkspan_Linux_${arch}.tar.gz`;
    log.info(`Downloading Linkspan from ${downloadUrl} for architecture ${arch}`);
    const installResult = await run.runRemoteCommand(session.cluster,
        `mkdir -p ~/.cybershuttle/bin && curl -fsSL "${downloadUrl}" | tar -xz -C ~/.cybershuttle/bin linkspan && chmod +x ~/.cybershuttle/bin/linkspan`);
    if (installResult.code !== 0) {
        throw new Error(`Failed to install Linkspan on cluster ${session.cluster}: ${installResult.stderr}`);
    }
    log.info(`Linkspan installed successfully on cluster ${session.cluster}`);
    log.info('Installation output:', installResult.stdout);
}

// On success mutates session.jobId/status/submittedAt in memory (the caller persists); throws on any failure.
export async function submitJobToSlurm(session: SlurmSession, run: RemoteRunner, log: LogSink): Promise<void> {
    if (!session.batchScript) { throw new Error(`Batch script is missing for session ${session.name}`); }

    const scriptB64 = Buffer.from(session.batchScript).toString('base64');
    const submitCommand = `mkdir -p ~/.cybershuttle/logs && echo '${scriptB64}' | base64 -d | sbatch`;
    log.info(`Submitting job to Slurm with command: ${submitCommand}`);

    const submitResult = await run.runRemoteCommand(session.cluster, submitCommand);
    if (submitResult.code !== 0) { throw new Error(`Job submission failed: ${submitResult.stderr}`); }

    const output = submitResult.stdout.trim();
    log.info(`Job submission output: ${output}`);
    const jobIdMatch = output.match(/Submitted batch job (\d+)/);
    if (!jobIdMatch) { throw new Error(`Failed to parse job ID from sbatch output: ${output}`); }

    session.jobId = jobIdMatch[1];
    session.status = 'queued'; // submitted and waiting in the queue
    session.submittedAt = Date.now();
    log.info(`Job submitted successfully with Job ID: ${session.jobId}`);
}

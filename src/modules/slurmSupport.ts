import { JobOutput, RecentJob, RecentJobsResult, SlurmJobStatus, SlurmSession } from "../models";
import { SshManager } from "./sshSupport";


const SQUEUE_FORMAT = '%i|%j|%T|%P|%M|%l|%R';
const SACCT_FORMAT = 'JobID,JobName,State,Partition,Elapsed,Timelimit,ExitCode';
const SCONTROL_FIELDS: Array<[keyof JobOutput, RegExp]> = [
    ['state', /JobState=(\S+)/],
    ['name', /JobName=(\S+)/],
    ['partition', /Partition=(\S+)/],
    ['submitTime', /SubmitTime=(\S+)/],
    ['startTime', /StartTime=(\S+)/],
    ['endTime', /EndTime=(\S+)/],
    ['nodeList', /NodeList=(\S+)/],
    ['workDir', /WorkDir=(\S+)/],
    ['account', /Account=(\S+)/],
    ['exitCode', /ExitCode=(\S+)/],
    ['reason', /Reason=(\S+)/],
    ['timeLimit', /TimeLimit=(\S+)/],
    ['elapsed', /RunTime=(\S+)/],
    ['stdoutPath', /StdOut=(\S+)/],
    ['stderrPath', /StdErr=(\S+)/],
];

function parseScontrolFields(text: string): Partial<JobOutput> {
    const out: Partial<JobOutput> = {};
    for (const [key, re] of SCONTROL_FIELDS) {
        const m = text.match(re);
        if (m && m[1] && m[1] !== '(null)') { out[key] = m[1]; }
    }
    return out;
}

function parseLines(stdout: string, tailKey: 'reason' | 'exitCode'): RecentJob[] {
    const rows: RecentJob[] = [];
    for (const line of stdout.split('\n')) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 7 || !parts[0]) { continue; }
        const [jobId, name, state, partition, elapsed, timeLimit, tail] = parts;
        rows.push({ jobId, name, state, partition, elapsed, timeLimit, [tailKey]: tail });
    }
    return rows;
}

export async function getRecentJobs(cluster: string): Promise<RecentJobsResult | null> {
    const sshManager = SshManager.getInstance();

    const squeueCmd = `squeue -u "$USER" -h -o '${SQUEUE_FORMAT}'`;
    const sacctCmd = `sacct -u "$USER" -X -n -P -o ${SACCT_FORMAT} --starttime now-30days`;
    const [squeueResult, sacctResult] = await Promise.all([
        sshManager.runRemoteCommand(cluster, squeueCmd),
        sshManager.runRemoteCommand(cluster, sacctCmd),
    ]);

    if (squeueResult.code !== 0) { return null; }

    const active = parseLines(squeueResult.stdout, 'reason');
    const activeIds = new Set(active.map(j => j.jobId));
    const recent = sacctResult.code === 0
        ? parseLines(sacctResult.stdout, 'exitCode').filter(j => !activeIds.has(j.jobId)).reverse().slice(0, 25)
        : [];
    return { active, recent };
}

export async function getJobOutput(cluster: string, jobId: string): Promise<JobOutput | null> {
    const sshManager = SshManager.getInstance();

    const scontrolResult = await sshManager.runRemoteCommand(cluster, `scontrol show job ${jobId}`);
    if (scontrolResult.code !== 0) { return null; }

    const parsed = parseScontrolFields(scontrolResult.stdout);
    const tailOf = async (filePath: string) => {
        const quoted = `'${filePath.replace(/'/g, `'\\''`)}'`;
        const r = await sshManager.runRemoteCommand(cluster, `tail -n 200 ${quoted} 2>/dev/null`);
        return r.code === 0 ? r.stdout : '';
    };

    const [stdout, stderr] = await Promise.all([
        parsed.stdoutPath ? tailOf(parsed.stdoutPath) : Promise.resolve(undefined),
        parsed.stderrPath ? tailOf(parsed.stderrPath) : Promise.resolve(undefined),
    ]);

    return { ...parsed, stdout, stderr, rawScontrol: scontrolResult.stdout.trim() };
}

export async function getSlurmJobOutput(slurmSession: SlurmSession): Promise<string> {
    const sshManager = SshManager.getInstance();

    const command = `cat ~/.cybershuttle/logs/linkspan-session-${slurmSession.jobId}.err`;
    const commandResult = await sshManager.runRemoteCommand(slurmSession.cluster, command);
    if (commandResult.code !== 0) {
        throw new Error(`Failed to get job output. SSH command error: ${commandResult.stderr}`);
    }

    return commandResult.stdout.trim();
}

export async function getSlurmJobStatus(slurmSession: SlurmSession): Promise<SlurmJobStatus> {

    const sshManager = SshManager.getInstance();

    const command = `sacct -j ${slurmSession.jobId} -n -o State%20,ExitCode,Reason%40 --parsable2 2>/dev/null | head -1`;
    const commandResult = await sshManager.runRemoteCommand(slurmSession.cluster, command);
    if (commandResult.code !== 0) {
        throw new Error(`Failed to get job status. SSH command error: ${commandResult.stderr}`);
    }

    const output = commandResult.stdout.trim();
    if (!output || output.length === 0) {
        throw new Error('Failed to get job status. No output from sacct command.');
    }

    if (output.split('|').length < 3) {
        throw new Error('Failed to get job status. Unexpected output format from sacct command. Output: ' + output);
    }

    /*
    FAILED|1:0|None
    CANCELLED by 1001|0:0|None
    RUNNING|0:0|None
    TIMEOUT|0:0|None
    */

    const [state, exitCode, reason] = output.split('|');
    if (state.includes('PENDING')) {
        return SlurmJobStatus.PENDING;
    }
    if (state.includes('CANCELLED')) {
        return SlurmJobStatus.CANCELLED;
    }
    if (state.includes('FAILED')) {
        return SlurmJobStatus.FAILED;
    }
    if (state.includes('TIMEOUT')) {
        return SlurmJobStatus.TIMEOUT;
    }
    if (state.includes('OUT_OF_MEMORY')) {
        return SlurmJobStatus.OUT_OF_MEMORY;
    }
    if (state.includes('COMPLETED')) {
        return SlurmJobStatus.COMPLETED;
    }
    if (state.includes('RUNNING')) {
        return SlurmJobStatus.RUNNING;
    }
    return SlurmJobStatus.UNKNOWN;
}
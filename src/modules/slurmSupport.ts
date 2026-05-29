import { SlurmJobStatus, SlurmSession } from "../models";
import { SshManager } from "./sshSupport";


export async function getSlurmJobOutput(slurmSession: SlurmSession): Promise<string> {
    const sshManager = SshManager.getInstance();

    const command = `cat ~/.cybershuttle/logs/linkspan-session-${slurmSession.jobId}.err`;
    const commandResult = await sshManager.runRemoteCommand(slurmSession.cluster, command);
    if (commandResult.code !== 0) {
        throw new Error(`Failed to get job output. SSH command error: ${commandResult.stderr}`);
    }

    return commandResult.stdout.trim();
}

export async function getSlurmJobStatus(slurmSession: SlurmSession): Promise<{ status: SlurmJobStatus, elapsedSec: number }> {

    const sshManager = SshManager.getInstance();

    const command = `sacct -j ${slurmSession.jobId} -n -o State%20,ExitCode,Reason%40,ElapsedRaw --parsable2 2>/dev/null | head -1`;
    const commandResult = await sshManager.runRemoteCommand(slurmSession.cluster, command);
    if (commandResult.code !== 0) {
        throw new Error(`Failed to get job status. SSH command error: ${commandResult.stderr}`);
    }

    const output = commandResult.stdout.trim();
    if (!output || output.length === 0) {
        throw new Error('Failed to get job status. No output from sacct command.');
    }

    if (output.split('|').length < 4) {
        throw new Error('Failed to get job status. Unexpected output format from sacct command. Output: ' + output);
    }

    /*
    FAILED|1:0|None|120
    CANCELLED by 1001|0:0|None|0
    RUNNING|0:0|None|345
    TIMEOUT|0:0|None|3600
    */

    const [state, , , elapsedRaw] = output.split('|');
    // ElapsedRaw is SLURM's authoritative run-time in whole seconds (no timezone/clock guessing).
    const elapsedSec = /^\d+$/.test(elapsedRaw.trim()) ? parseInt(elapsedRaw.trim(), 10) : 0;

    let status = SlurmJobStatus.UNKNOWN;
    if (state.includes('PENDING')) { status = SlurmJobStatus.PENDING; }
    else if (state.includes('CANCELLED')) { status = SlurmJobStatus.CANCELLED; }
    else if (state.includes('FAILED')) { status = SlurmJobStatus.FAILED; }
    else if (state.includes('TIMEOUT')) { status = SlurmJobStatus.TIMEOUT; }
    else if (state.includes('OUT_OF_MEMORY')) { status = SlurmJobStatus.OUT_OF_MEMORY; }
    else if (state.includes('COMPLETED')) { status = SlurmJobStatus.COMPLETED; }
    else if (state.includes('RUNNING')) { status = SlurmJobStatus.RUNNING; }

    return { status, elapsedSec };
}
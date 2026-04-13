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
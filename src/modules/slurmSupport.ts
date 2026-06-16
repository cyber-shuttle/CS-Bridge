import { SlurmClusterInfo, SlurmJobStatus, SlurmSession } from "../models";
import { Logger } from "../logger";
import { SshManager } from "./sshSupport";
import { parsePartitionLine } from "./slurmParse";


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

/**
* Query SLURM partition and account info for the current user on a remote host.
* Returns a SlurmClusterInfo with accounts, partitions, and homeDir fields.
*/
export async function getSlurmClusterInfo(hostName: string): Promise<SlurmClusterInfo> {
    const sshManager = SshManager.getInstance();
    const log = Logger.getInstance();
    const clusterInfo: SlurmClusterInfo = { host: hostName, accounts: [], partitions: [] };
    try {
        const accountResult = await sshManager.runRemoteCommand(hostName,
            'sacctmgr show associations where user=$USER format=Account -p');

        if (accountResult.code === 0) {
            log.info(accountResult.stdout);

            // Parse pipe-delimited output into account → QOS mapping
            const lines = accountResult.stdout.trim().split('\n');

            for (let i = 1; i < lines.length; i++) { // skip header
                const parts = lines[i].trim().split('|');
                log.info(`Parsed account line: ${lines[i]} → ${parts} {length: ${parts.length}}`);
                if (parts.length >= 1) {
                    const account = parts[0].trim();
                    if (account) {
                        clusterInfo.accounts.push(account);
                    }
                }
            }
        } else {
            log.warn(`Command exited with code ${accountResult.code}`);
            if (accountResult.stderr) {
                log.error(accountResult.stderr);
            }
            throw new Error(`Failed to query associations: ${accountResult.stderr || 'Unknown error'}`);
        }

    } catch (err) {
        log.error('Error querying associations:', err);
        throw err;
    }

    try {
        const partitionResult = await sshManager.runRemoteCommand(hostName, 'sinfo -h -o "%P|%c|%m|%G"');
        /* Example output:
        interactive-cpu|24|191000+|gpu:v100:2(S:0-1)
        interactive-cpu1|24|385000+|gpu:rtx_6000:4(S:0-1)
        interactive-cpu2|64|515000|gpu:a100:2(S:2,5)
        cpu-small*|24+|191000+|(null)
        cpu-amd|128|515000+|(null)
        */
        if (partitionResult.code === 0) {
            log.info(partitionResult.stdout);
            clusterInfo.partitions = partitionResult.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map(parsePartitionLine);
        }
    } catch (err) {
        log.warn(`Failed to query partitions: ${err instanceof Error ? err.message : String(err)}`);
        // Don't throw, since accounts info may still be useful
    }

    try {
        const homeResult = await sshManager.runRemoteCommand(hostName, 'echo $HOME');
        if (homeResult.code === 0) { clusterInfo.homeDir = homeResult.stdout.trim(); }
    } catch (err) {
        log.warn(`Failed to query $HOME: ${err instanceof Error ? err.message : String(err)}`);
    }

    return clusterInfo;
}
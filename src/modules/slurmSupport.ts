import { SlurmClusterInfo, SlurmJobStatus, SlurmSession } from '../models';
import { Logger, errMsg } from '../logger';
import { SshManager } from './sshSupport';
import { parseAccounts, parsePartitionLine, parseSacctStatus } from './slurmParse';

export async function getSlurmJobStatus(slurmSession: SlurmSession): Promise<{ status: SlurmJobStatus; elapsedSec: number }> {
    const command = `sacct -j ${slurmSession.jobId} -n -o State%20,ExitCode,Reason%40,ElapsedRaw --parsable2 2>/dev/null | head -1`;
    const commandResult = await SshManager.getInstance().runRemoteCommand(slurmSession.cluster, command, { batch: true });
    if (commandResult.code !== 0) {
        throw new Error(`Failed to get job status. SSH command error: ${commandResult.stderr}`);
    }
    return parseSacctStatus(commandResult.stdout.trim());
}

export async function getSlurmClusterInfo(hostName: string): Promise<SlurmClusterInfo> {
    const sshManager = SshManager.getInstance();
    const log = Logger.getInstance();
    const clusterInfo: SlurmClusterInfo = { host: hostName, accounts: [], partitions: [] };
    // Only the first command authenticates (later ones reuse the ControlMaster socket), so the auth box surfaces here.
    // Slurm's database lowercases account names; TACC's submit filter wants them as project.map spells them.
    try {
        const accountResult = await sshManager.runRemoteCommand(hostName,
            'sacctmgr -n show associations where user=$USER format=Account -P'
            + ' | if [ -r /usr/local/etc/project.map ]; then grep -iwf - /usr/local/etc/project.map | cut -d" " -f1; else cat; fi');

        if (accountResult.code === 0) {
            clusterInfo.accounts = parseAccounts(accountResult.stdout);
        }
        else {
            throw new Error(`Failed to query associations (exit ${accountResult.code}): ${accountResult.stderr || 'Unknown error'}`);
        }
    }
    catch (err) {
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
            clusterInfo.partitions = partitionResult.stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map(parsePartitionLine);
        }
    }
    catch (err) {
        log.warn(`Failed to query partitions: ${errMsg(err)}`); // non-fatal: accounts info may still be useful
    }

    try {
        const homeResult = await sshManager.runRemoteCommand(hostName, 'echo $HOME');
        if (homeResult.code === 0) { clusterInfo.homeDir = homeResult.stdout.trim(); }
    }
    catch (err) {
        log.warn(`Failed to query $HOME: ${errMsg(err)}`);
    }

    return clusterInfo;
}

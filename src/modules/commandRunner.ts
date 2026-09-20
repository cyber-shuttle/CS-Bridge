// The ssh and ssh-keygen seam of the SSH resources pipeline. Tests inject a fake.
import { spawnSync } from 'child_process';

export type CommandResult = { stdout: string; status: number | null };
export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

export const systemRunner: CommandRunner = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf-8' });
    return { stdout: result.stdout ?? '', status: result.status };
};

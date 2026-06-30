// Pure protocol for driving one persistent remote login shell: frame each command with a per-call random
// marker so its stdout, stderr, and exit code can be demuxed from the shell's continuous output streams.

// Printed once at connect to skip profile/MOTD noise before the first command. A fixed token; remote profile
// output colliding with it is effectively impossible. ponytail: bump to a random per-shell token if it ever does.
export const READY_MARKER = '__CS_SHELL_READY__';

const marker = (rid: string): string => `__CSE_${rid}__`;

// Run `command`, capture its exit code before the marker printf overwrites $?, then emit the code on stdout and
// a matching boundary on stderr. Commands here are single-line and never read stdin (the shell's stdin is ours).
export function buildShellCommand(rid: string, command: string): string {
    const m = marker(rid);
    return `${command}\n__cs=$?; printf '\\n${m} %s\\n' "$__cs"; printf '\\n${m}\\n' 1>&2\n`;
}

// Null until both sentinels have arrived; otherwise the payload preceding each (the injected leading \n is the
// separator, so output without a trailing newline still splits cleanly).
export function extractCommandResult(
    rid: string,
    outBuf: string,
    errBuf: string,
): { stdout: string; stderr: string; code: number } | null {
    const m = marker(rid);
    const out = outBuf.match(new RegExp(`\\n${m} (\\d+)\\n`));
    const err = errBuf.match(new RegExp(`\\n${m}\\n`));
    if (!out || !err) { return null; }
    return { stdout: outBuf.slice(0, out.index), stderr: errBuf.slice(0, err.index), code: Number(out[1]) };
}

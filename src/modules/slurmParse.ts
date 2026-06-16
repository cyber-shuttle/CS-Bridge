import { GresInfo, SlurmPartitionInfo, SlurmSession, TunnelCredential } from "../models";

// Pure SLURM text helpers: parse `sinfo`/`sacctmgr` output and build the sbatch script. No SSH/vscode
// dependency, so these are unit-testable in isolation (see slurmParse.test.ts).

export function generateSlurmScript(session: SlurmSession, tunnelCred: TunnelCredential): string {
    // Parse memory value (e.g. "8 GB" → "8G")
    const memSlurm = session.memory.replace(/\s+/g, '');

    const sbatchLines = [
        `#SBATCH --job-name=linkspan-session`,
        `#SBATCH --ntasks=1`,
        `#SBATCH --cpus-per-task=${session.cpus}`,
        `#SBATCH --mem=${memSlurm}`,
        `#SBATCH --time=${session.wallTime}`,
        `#SBATCH --partition=${session.queue}`,
        `#SBATCH --account=${session.allocation}`,
    ];

    // Add GPU if selected (format: "type:count" or "count")
    if (session.gpuClass !== '' && session.gpuCount > 0) {
        sbatchLines.push(`#SBATCH --gres=gpu:${session.gpuClass}`);
    }

    const scriptLines = [
        `#!/bin/bash`,
        ...sbatchLines,
        ``,
        `# --- Set up log files using $HOME ---`,
        `LOG_DIR="$HOME/.cybershuttle/logs"`,
        `mkdir -p "$LOG_DIR"`,
        `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
        ``,
        `# --- Run linkspan (pre-deployed via scp) ---`,
        `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
        `"$LINKSPAN_BIN" --port 0 --tunnel-auth-token '${tunnelCred.authToken}' --tunnel-id '${session.tunnelId ?? ''}' --tunnel-cluster '${session.tunnelCluster ?? ''}' -tunnel-enable`,
    ];

    return scriptLines.join('\n');
}

// Parse one `sinfo -h -o "%P|%c|%m|%G"` line into a partition descriptor.
export function parsePartitionLine(line: string): SlurmPartitionInfo {
    const parts = line.split("|").map((p) => p.trim());

    if (parts.length !== 4) {
        throw new Error(`Invalid sinfo line: ${line}`);
    }

    const [rawName, rawCpuCount, rawMemory, rawGres] = parts;

    return {
        name: rawName.replace(/\*$/, ""), // remove default-partition marker
        cpuCount: parseLeadingInt(rawCpuCount), // handles "24+"
        memory: rawMemory, // keep "191000+" as-is
        gres: parseGres(rawGres),
    };
}

function parseLeadingInt(value: string): number {
    const match = value.match(/\d+/);
    if (!match) {
        throw new Error(`Could not parse integer from: ${value}`);
    }
    return Number.parseInt(match[0], 10);
}

function parseGres(rawGres: string): GresInfo[] {
    if (!rawGres || rawGres === "(null)") {
        return [];
    }

    return splitTopLevelComma(rawGres).map((entry) => {
        // Examples: gpu:v100:2(S:0-1), gpu:rtx_6000:4(S:0-1), gpu:8
        const match = entry.match(/^(.+):(\d+)(?:\([^)]*\))?$/);

        if (!match) {
            throw new Error(`Invalid GRES entry: ${entry}`);
        }

        return {
            name: match[1],   // e.g. "gpu:v100"
            count: Number.parseInt(match[2], 10),
        };
    });
}

function splitTopLevelComma(value: string): string[] {
    const result: string[] = [];
    let current = "";
    let depth = 0;

    for (const ch of value) {
        if (ch === "(") { depth++; }
        if (ch === ")") { depth--; }

        if (ch === "," && depth === 0) {
            result.push(current.trim());
            current = "";
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

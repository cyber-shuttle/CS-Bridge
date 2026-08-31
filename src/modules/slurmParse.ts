import { GresInfo, Stats, SlurmJobStatus, SlurmPartitionInfo, SlurmSession } from '../models';

// Pure Slurm text helpers (no SSH/vscode), so they unit-test in isolation. See slurmParse.test.ts.

// Linkspan's unix socket, the portless in-allocation channel. It sits directly in
// the sticky world-writable /tmp: a shared csbridge/ subdir would be owned by the
// first user on the node and every other user would fail to bind.
export const linkspanSocketPath = (sessionId: string): string => `/tmp/csbridge-${sessionId}.sock`;

// A Slurm account is a bare token; a blank or a sentinel like "(No Allocation)" yields '' (no --account).
export const slurmAccount = (raw: string | undefined): string => (raw ?? '').trim().match(/^[\w.-]+$/)?.[0] ?? '';

// Distinct accounts from `sacctmgr show associations ... format=Account -p`; it prints one
// row per (account, partition) association, so per-partition accounts repeat.
export function parseAccounts(output: string): string[] {
    const names = output.trim().split(/\r?\n/).slice(1)
        .map(l => l.split('|')[0].trim())
        .filter(Boolean);
    return [...new Set(names)];
}

export function buildSlurmScript(session: SlurmSession, hostToken: string): string {
    const memSlurm = session.memory.replace(/\s+/g, '');
    const socketPath = linkspanSocketPath(session.id);
    const account = slurmAccount(session.allocation);

    const sbatchLines = [
        `#SBATCH --job-name=linkspan-session`,
        `#SBATCH --nodes=1`,
        `#SBATCH --ntasks=1`,
        `#SBATCH --cpus-per-task=${session.cpus}`,
        `#SBATCH --mem=${memSlurm}`,
        `#SBATCH --time=${session.wallTime}`,
        `#SBATCH --partition=${session.queue}`,
        ...(account ? [`#SBATCH --account=${account}`] : []),
        ...(session.gpuClass !== '' && session.gpuCount > 0 ? [`#SBATCH --gres=${session.gpuClass}`] : []),
    ];

    const scriptLines = [
        `#!/bin/bash`,
        ...sbatchLines,
        ``,
        `# --- Set up log files using $HOME ---`,
        `LOG_DIR="$HOME/.cybershuttle/logs"`,
        `install -d -m 700 "$LOG_DIR"`,
        `exec > "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.out" 2> "$LOG_DIR/linkspan-session-$SLURM_JOB_ID.err"`,
        ``,
        `# The compute node has no logind, so the inherited /run/user/$UID (XDG_RUNTIME_DIR) is absent there;`,
        `# unset it (and TMPDIR) so the VS Code server linkspan launches falls back to its node-local /tmp default.`,
        `unset XDG_RUNTIME_DIR TMPDIR`,
        ``,
        `# --- Run linkspan ---`,
        `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
        // Bind the port csbridge pinned at launch so it knows the tunnel URL up front (no log/port discovery).
        `"$LINKSPAN_BIN" --port ${session.connectionInfo?.apiPort ?? 0} --socket ${socketPath} --tunnel-host-token '${hostToken}' --tunnel-id '${session.tunnelId ?? ''}' --tunnel-cluster '${session.tunnelCluster ?? ''}' -tunnel-enable`,
    ];

    return scriptLines.join('\n');
}

// One `sacct --parsable2` row: State|ExitCode|Reason|ElapsedRaw
export function parseSacctStatus(output: string): { status: SlurmJobStatus; elapsedSec: number } {
    if (!output) {
        throw new Error('Failed to get job status. No output from sacct command.');
    }
    const fields = output.split('|');
    if (fields.length < 4) {
        throw new Error('Failed to get job status. Unexpected output format from sacct command. Output: ' + output);
    }
    /*
    FAILED|1:0|None|120
    CANCELLED by 1001|0:0|None|0
    RUNNING|0:0|None|345
    TIMEOUT|0:0|None|3600
    */
    const [state, , , elapsedRaw] = fields;
    // ElapsedRaw is Slurm's authoritative run-time in whole seconds (no timezone/clock guessing).
    const elapsedSec = /^\d+$/.test(elapsedRaw.trim()) ? parseInt(elapsedRaw.trim(), 10) : 0;

    return { status: classifySchedulerState(state), elapsedSec };
}

// The scheduler's vocabulary in one place, mirroring cs-control's own table. An
// absent state reads as UNKNOWN, which the monitor holds rather than treating as
// job death, so an unlisted state strands a session until its wall time.
// SUSPENDED and STOPPED still hold an allocation, so they read as QUEUED.
const SCHEDULER_STATES: Readonly<Record<string, SlurmJobStatus>> = {
    PENDING: SlurmJobStatus.QUEUED,
    REQUEUED: SlurmJobStatus.QUEUED,
    REQUEUE_FED: SlurmJobStatus.QUEUED,
    REQUEUE_HOLD: SlurmJobStatus.QUEUED,
    SUSPENDED: SlurmJobStatus.QUEUED,
    STOPPED: SlurmJobStatus.QUEUED,

    RUNNING: SlurmJobStatus.RUNNING,
    CONFIGURING: SlurmJobStatus.RUNNING,
    COMPLETING: SlurmJobStatus.RUNNING,
    RESIZING: SlurmJobStatus.RUNNING,
    SIGNALING: SlurmJobStatus.RUNNING,
    STAGE_OUT: SlurmJobStatus.RUNNING,

    COMPLETED: SlurmJobStatus.COMPLETED,
    CANCELLED: SlurmJobStatus.CANCELLED,
    TIMEOUT: SlurmJobStatus.TIMEOUT,

    BOOT_FAIL: SlurmJobStatus.FAILED,
    DEADLINE: SlurmJobStatus.FAILED,
    FAILED: SlurmJobStatus.FAILED,
    NODE_FAIL: SlurmJobStatus.FAILED,
    OUT_OF_MEMORY: SlurmJobStatus.OUT_OF_MEMORY,
    PREEMPTED: SlurmJobStatus.FAILED,
    REVOKED: SlurmJobStatus.FAILED,
    SPECIAL_EXIT: SlurmJobStatus.FAILED,
};

// sacct decorates a state with the reason ("CANCELLED by 1001") and marks a
// truncated one with a trailing "+", so only the first token is the state.
export function classifySchedulerState(raw: string): SlurmJobStatus {
    const token = raw.trim().split(/\s+/)[0] ?? '';
    return SCHEDULER_STATES[token.replace(/\+$/, '').toUpperCase()] ?? SlurmJobStatus.UNKNOWN;
}

// With `--units=K`, sacct emits every memory field (MaxRSS, ReqMem) in KiB, so a value is just its leading number —
// parseFloat drops the trailing 'K' and any legacy per-CPU/node 'c'/'n'. Blank/unparseable → undefined.
function parseKib(s: string | undefined): number | undefined {
    const n = parseFloat((s ?? '').trim());
    return Number.isFinite(n) ? n : undefined;
}

// Slurm "[DD-]HH:MM:SS" / "MM:SS" duration → seconds. Consumed CPU (TotalCPU) has no raw-seconds field, so this stays.
function hmsSeconds(s: string | undefined): number | undefined {
    const t = s?.trim();
    if (!t) { return undefined; }
    const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
    const parts = rest.split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) { return undefined; }
    return Number(days) * 86400 + parts.reduce((sec, p) => sec * 60 + p, 0);
}

export function humanKib(kib: number): string {
    if (kib >= 1024 ** 2) { return `${(kib / 1024 ** 2).toFixed(1)} GB`; }
    if (kib >= 1024) { return `${(kib / 1024).toFixed(1)} MB`; }
    return `${Math.round(kib)} KB`;
}

// Parse `sacct -P -n --units=K` rows (JobID|AllocCPUs|ReqMem|ElapsedRaw|CPUTimeRAW|MaxRSS|TotalCPU).
// Usage lives on the .batch step where the workload runs; .extern and our own srun
// poll steps would mask it with their near-zero values.
export function parseSacctUtil(output: string): Stats {
    const rows = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split('|'));
    if (rows.length === 0) { return {}; }
    const alloc = rows.find(r => !r[0].includes('.')) ?? rows[0];
    const usage = rows.find(r => r[0].endsWith('.batch')) ?? alloc;

    const m: Stats = {};
    const cores = Number(alloc[1]);
    if (Number.isFinite(cores) && cores > 0) { m.cores = cores; }
    const reqMemKib = parseKib(alloc[2]);
    if (alloc[3] && Number.isFinite(Number(alloc[3]))) { m.elapsedSec = Number(alloc[3]); }
    const allocCpuSec = Number(alloc[4]); // CPUTimeRAW = elapsed × cpus

    const maxRssKib = parseKib(usage[5]);
    const usedCpuSec = hmsSeconds(usage[6]);

    if (reqMemKib !== undefined) { m.reqMem = humanKib(reqMemKib); }
    if (maxRssKib !== undefined) { m.maxRss = humanKib(maxRssKib); }
    // TotalCPU is 00:00:00 until the step ends, so a zero means "not flushed yet", not a truly idle job — skip it.
    if (usedCpuSec && Number.isFinite(allocCpuSec) && allocCpuSec > 0) {
        m.cpuEfficiencyPct = usedCpuSec / allocCpuSec * 100;
    }
    if (maxRssKib !== undefined && reqMemKib) { m.memEfficiencyPct = maxRssKib / reqMemKib * 100; }
    return m;
}

// One `sinfo -h -o "%P|%c|%m|%G"` line: name|cpuCount|memory|gres
export function parsePartitionLine(line: string): SlurmPartitionInfo {
    const parts = line.split('|').map(p => p.trim());

    if (parts.length !== 4) {
        throw new Error(`Invalid sinfo line: ${line}`);
    }

    const [rawName, rawCpuCount, rawMemory, rawGres] = parts;

    return {
        name: rawName.replace(/\*$/, ''), // trailing "*" marks the default partition
        cpuCount: parseLeadingInt(rawCpuCount),
        memory: rawMemory,
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
    if (!rawGres || rawGres === '(null)') {
        return [];
    }

    return splitCommaOutsideParens(rawGres).map((entry) => {
        // Examples: gpu:v100:2(S:0-1), gpu:rtx_6000:4(S:0-1), gpu:8
        const match = entry.match(/^(.+):(\d+)(?:\([^)]*\))?$/);

        if (!match) {
            throw new Error(`Invalid GRES entry: ${entry}`);
        }

        return {
            name: match[1],
            count: Number.parseInt(match[2], 10),
        };
    });
}

function splitCommaOutsideParens(value: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;

    for (const ch of value) {
        if (ch === '(') { depth++; }
        if (ch === ')') { depth--; }

        if (ch === ',' && depth === 0) {
            result.push(current.trim());
            current = '';
            continue;
        }

        current += ch;
    }

    if (current.trim()) {
        result.push(current.trim());
    }

    return result;
}

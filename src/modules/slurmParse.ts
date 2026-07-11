import { GresInfo, RunMetrics, SlurmJobStatus, SlurmPartitionInfo, SlurmSession, TunnelCredential } from '../models';

// Pure SLURM text helpers (no SSH/vscode), so they unit-test in isolation. See slurmParse.test.ts.

export function buildSlurmScript(session: SlurmSession, tunnelCred: TunnelCredential): string {
    const memSlurm = session.memory.replace(/\s+/g, '');

    const sbatchLines = [
        `#SBATCH --job-name=linkspan-session`,
        `#SBATCH --nodes=1`,
        `#SBATCH --ntasks=1`,
        `#SBATCH --cpus-per-task=${session.cpus}`,
        `#SBATCH --mem=${memSlurm}`,
        `#SBATCH --time=${session.wallTime}`,
        `#SBATCH --partition=${session.queue}`,
        `#SBATCH --account=${session.allocation}`,
    ];

    if (session.gpuClass !== '' && session.gpuCount > 0) {
        sbatchLines.push(`#SBATCH --gres=${session.gpuClass}`);
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
        `# The compute node has no logind, so the inherited /run/user/$UID (XDG_RUNTIME_DIR) is absent there;`,
        `# unset it (and TMPDIR) so the VS Code server linkspan launches falls back to its node-local /tmp default.`,
        `unset XDG_RUNTIME_DIR TMPDIR`,
        ``,
        `# --- Run linkspan (pre-deployed via scp) ---`,
        `LINKSPAN_BIN="$HOME/.cybershuttle/bin/linkspan"`,
        // Bind the port csbridge pinned at launch so it knows the tunnel URL up front (no log/port discovery).
        `"$LINKSPAN_BIN" --port ${session.connectionInfo?.apiPort ?? 0} --tunnel-auth-token '${tunnelCred.authToken}' --tunnel-id '${session.tunnelId ?? ''}' --tunnel-cluster '${session.tunnelCluster ?? ''}' -tunnel-enable`,
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
    // ElapsedRaw is SLURM's authoritative run-time in whole seconds (no timezone/clock guessing).
    const elapsedSec = /^\d+$/.test(elapsedRaw.trim()) ? parseInt(elapsedRaw.trim(), 10) : 0;

    let status = SlurmJobStatus.UNKNOWN;
    if (state.includes('PENDING')) { status = SlurmJobStatus.QUEUED; } // sacct's wire token is PENDING; we call it QUEUED
    else if (state.includes('CANCELLED')) { status = SlurmJobStatus.CANCELLED; }
    else if (state.includes('FAILED')) { status = SlurmJobStatus.FAILED; }
    else if (state.includes('TIMEOUT')) { status = SlurmJobStatus.TIMEOUT; }
    else if (state.includes('OUT_OF_MEMORY')) { status = SlurmJobStatus.OUT_OF_MEMORY; }
    else if (state.includes('COMPLETED')) { status = SlurmJobStatus.COMPLETED; }
    else if (state.includes('RUNNING')) { status = SlurmJobStatus.RUNNING; }

    return { status, elapsedSec };
}

const MEM_UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

// SLURM memory token → bytes: "1234K" / "2.5G" / "512M" / "1048576" (bare = bytes). Empty/unparseable → undefined.
function parseMemBytes(s: string | undefined): number | undefined {
    const m = s?.trim().match(/^([\d.]+)\s*([KMGTP])?i?B?$/i);
    if (!m || !Number.isFinite(Number(m[1]))) { return undefined; }
    return Number(m[1]) * (m[2] ? MEM_UNIT[m[2].toUpperCase()] : 1);
}

// ReqMem total in bytes. Historic SLURM suffixes: 'c' = per-CPU (× cores), 'n' = per-node (assume one node).
function parseReqMemBytes(reqMem: string | undefined, cores: number | undefined): number | undefined {
    if (!reqMem) { return undefined; }
    const base = parseMemBytes(reqMem.replace(/[cn]$/i, ''));
    return base === undefined ? undefined : (/c$/i.test(reqMem) ? base * (cores ?? 1) : base);
}

// "[DD-]HH:MM:SS" / "MM:SS" / plain seconds → seconds.
function parseCpuTime(s: string): number {
    const [maybeDays, rest] = s.includes('-') ? s.split('-') : ['0', s];
    const parts = rest.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) { return 0; }
    return Number(maybeDays) * 86400 + parts.reduce((sec, p) => sec * 60 + p, 0);
}

// Used CPU-seconds from a TRESUsageInTot string like "cpu=00:26:00,mem=1234K,…". undefined when no cpu= is present.
function tresCpuSeconds(tres: string | undefined): number | undefined {
    const m = tres?.match(/cpu=([^,]+)/);
    return m ? parseCpuTime(m[1]) : undefined;
}

function humanBytes(bytes: number): string {
    for (const [unit, size] of [['GB', MEM_UNIT.G], ['MB', MEM_UNIT.M], ['KB', MEM_UNIT.K]] as const) {
        if (bytes >= size) { return `${(bytes / size).toFixed(1)} ${unit}`; }
    }
    return `${bytes} B`;
}

// Parse `sacct -P -n` rows (JobID|AllocCPUs|ReqMem|CPUTimeRAW|ElapsedRaw|MaxRSS|AllocTRES|TRESUsageInTot). Usage
// (MaxRSS, used CPU) is on the step rows, blank on a -X row, so efficiency is derived only when it's present.
export function parseSacctUtil(output: string): RunMetrics {
    const rows = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split('|'));
    if (rows.length === 0) { return {}; }
    const alloc = rows.find(r => !r[0].includes('.')) ?? rows[0]; // main allocation record, not ".batch"/".extern"

    const m: RunMetrics = {};
    const cores = Number(alloc[1]);
    if (Number.isFinite(cores) && cores > 0) { m.cores = cores; }
    if (alloc[2]) { m.reqMem = alloc[2]; }
    if (alloc[4] && Number.isFinite(Number(alloc[4]))) { m.elapsedSec = Number(alloc[4]); }

    const rssValues = rows.map(r => parseMemBytes(r[5])).filter((n): n is number => n !== undefined);
    const cpuValues = rows.map(r => tresCpuSeconds(r[7])).filter((n): n is number => n !== undefined);
    const maxRssBytes = rssValues.length ? Math.max(...rssValues) : undefined;
    const usedCpuSec = cpuValues.length ? Math.max(...cpuValues) : undefined;
    const cpuTimeRaw = Number(alloc[3]);

    if (maxRssBytes !== undefined) { m.maxRss = humanBytes(maxRssBytes); }
    if (usedCpuSec !== undefined && Number.isFinite(cpuTimeRaw) && cpuTimeRaw > 0) {
        m.cpuEfficiencyPct = usedCpuSec / cpuTimeRaw * 100;
    }
    const reqBytes = parseReqMemBytes(alloc[2], m.cores);
    if (maxRssBytes !== undefined && reqBytes) { m.memEfficiencyPct = maxRssBytes / reqBytes * 100; }
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

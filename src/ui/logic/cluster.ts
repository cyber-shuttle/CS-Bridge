import type { SlurmClusterInfo, SlurmPartitionInfo } from '@/models';

export type ResourceTab = 'cpu' | 'gpu';

interface GpuOptions {
    counts: number[];
    types: string[];
}

const hasGres = (p: SlurmPartitionInfo): boolean => !!p.gres && p.gres.length > 0;

export function partitionsForTab(info: SlurmClusterInfo, tab: ResourceTab): SlurmPartitionInfo[] {
    return info.partitions.filter(p => (tab === 'gpu' ? hasGres(p) : !hasGres(p)));
}

export function hasTab(info: SlurmClusterInfo, tab: ResourceTab): boolean {
    return partitionsForTab(info, tab).length > 0;
}

export function cpuOptions(partition: SlurmPartitionInfo | undefined): number[] {
    const max = Math.max(0, partition?.cpuCount ?? 0);
    return Array.from({ length: max }, (_, i) => i + 1);
}

const MEM_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const MEM_FALLBACK = [1, 2, 4, 8, 16, 32, 64, 128];

// Legacy parity: non-numeric/zero memory falls back to a fixed list rather than
// special-casing values like 'unlimited' (matches the old updateMemoryOptions).
export function memoryOptions(partition: SlurmPartitionInfo | undefined): string[] {
    const maxGb = Math.floor((Number(partition?.memory) || 0) / 1024);
    const valid = maxGb <= 0 ? MEM_FALLBACK : MEM_STEPS.filter(g => g <= maxGb);
    return (valid.length ? valid : [1]).map(g => `${g} GB`);
}

export function gpuOptions(partition: SlurmPartitionInfo | undefined, tab: ResourceTab): GpuOptions {
    if (tab !== 'gpu' || !partition || !hasGres(partition)) { return { counts: [], types: [] }; }
    const max = partition.gres[0].count; // legacy parity: count ceiling from the first gres entry
    return {
        counts: Array.from({ length: max }, (_, i) => i + 1),
        types: partition.gres.map(g => g.name),
    };
}

/** SLURM gres string the extension expects (mirrors the old submit handler). */
export function gpuString(gpuType: string, gpuCount: number): string {
    if (gpuCount <= 0) { return 'None'; }
    return gpuType ? `${gpuType}:${gpuCount}` : `${gpuCount}`;
}

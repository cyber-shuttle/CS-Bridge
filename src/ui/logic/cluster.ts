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
    // 2-CPU floor: a 1-CPU dev host is impractical for the VS Code server.
    return Array.from({ length: Math.max(0, max - 1) }, (_, i) => i + 2);
}

// 4 GB floor: 2 GB OOM-kills the VS Code remote server/extension host (observed on Delta: the 2 GB cgroup OOMs the ptyHost).
const MEM_STEPS = [4, 8, 16, 32, 64, 128, 256, 512, 1024];
const MEM_FALLBACK = [4, 8, 16, 32, 64, 128];

// Non-numeric/zero memory (e.g. 'unlimited') falls back to a fixed list of GB steps.
export function memoryOptions(partition: SlurmPartitionInfo | undefined): string[] {
    const maxGb = Math.floor((Number(partition?.memory) || 0) / 1024);
    const valid = maxGb <= 0 ? MEM_FALLBACK : MEM_STEPS.filter(g => g <= maxGb);
    return (valid.length ? valid : [4]).map(g => `${g} GB`);
}

export function gpuOptions(partition: SlurmPartitionInfo | undefined, tab: ResourceTab): GpuOptions {
    if (tab !== 'gpu' || !partition || !hasGres(partition)) { return { counts: [], types: [] }; }
    const max = partition.gres[0].count;
    return {
        counts: Array.from({ length: max }, (_, i) => i + 1),
        types: partition.gres.map(g => g.name),
    };
}

export function gpuString(gpuType: string, gpuCount: number): string {
    if (gpuCount <= 0) { return 'None'; }
    return gpuType ? `${gpuType}:${gpuCount}` : `${gpuCount}`;
}

// Inverse of gpuString for the edit-form prefill. The gres type can contain colons (e.g. "gpu:a100"), so the count
// is the segment after the LAST colon, not the first.
export function parseGpuClass(gpuClass: string): { gpuType: string; gpuCount: string } | undefined {
    if (!gpuClass || gpuClass === 'None') { return undefined; }
    const idx = gpuClass.lastIndexOf(':');
    return idx === -1
        ? { gpuType: '', gpuCount: gpuClass }
        : { gpuType: gpuClass.slice(0, idx), gpuCount: gpuClass.slice(idx + 1) };
}

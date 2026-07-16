import { METRICS_HISTORY_LEN, type GpuStat, type Metric } from '@/models';
import { cpuCoreSeries } from '@/ui/logic/metrics';
import { humanKib } from '@/modules/slurmParse';
import { Row, Stack, Text } from '@/ui/components/base';
import { Sparkline, type SparkLine } from '@/ui/components/Sparkline';

const CHART = { cpu: 'var(--vscode-charts-blue)', mem: 'var(--vscode-charts-purple)', gpu: 'var(--vscode-charts-green)', gpuMem: 'var(--vscode-charts-orange)' };
const PCT: [number, number] = [0, 100];
const pct = (unit: string) => (v: number) => `${Math.round(v)}% ${unit}`;
const gpuMemPct = (g?: GpuStat) => (g && g.memTotalMiB ? (g.memUsedMiB / g.memTotalMiB) * 100 : undefined);

type Graph = { label: string; lines: (SparkLine & { fmt: (v: number) => string })[] };

// CPU / memory / per-GPU series from a rolling live-sample window, in MEM, CPU, GPU order.
export function metricGraphs(history: Metric[], gpuCount: number): Graph[] {
    function at<T>(f: (s: Metric) => T | undefined): T[] { return history.map(f).filter((v): v is T => v !== undefined); }
    const gpuN = Math.max(gpuCount > 0 ? 1 : 0, ...history.map(s => s.gpus?.length ?? 0));
    return [
        { label: 'MEM', lines: [{ values: at(s => s.memBytes), color: CHART.mem, fmt: v => humanKib(v / 1024) }] },
        { label: 'CPU', lines: [{ values: cpuCoreSeries(history), color: CHART.cpu, fmt: v => `${v.toFixed(1)} cores` }] },
        ...Array.from({ length: gpuN }, (_, i): Graph => ({
            label: gpuN > 1 ? `GPU${i}` : 'GPU',
            lines: [
                { values: at(s => s.gpus?.[i]?.utilPct), color: CHART.gpu, domain: PCT, fmt: pct('util') },
                { values: at(s => gpuMemPct(s.gpus?.[i])), color: CHART.gpuMem, domain: PCT, fmt: pct('mem') },
            ],
        })),
    ];
}

export const graphTitle = (g: Graph) => `${g.label} — ${g.lines.map(l => l.fmt(l.values.at(-1)!)).join(', ')}`;

export function MetricGraphs({ history, gpuCount }: { history: Metric[]; gpuCount: number }) {
    const shown = metricGraphs(history, gpuCount).filter(g => g.lines[0].values.length >= 2);
    if (!shown.length) { return null; }
    return (
        <Row gap={8} wrap>
            {shown.map(g => (
                <Stack key={g.label} gap={1}>
                    <Text muted size={10}>{g.label}</Text>
                    <Sparkline lines={g.lines} slots={METRICS_HISTORY_LEN} title={graphTitle(g)} />
                </Stack>
            ))}
        </Row>
    );
}

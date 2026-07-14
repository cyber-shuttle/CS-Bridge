import { Row, Stack, Text } from '@/ui/components/base';
import { efficiencySeverity, SEVERITY_COLOR, fmtPct } from '@/ui/logic/metrics';
import { fmtTime } from '@/ui/logic/session';
import type { RunMetrics } from '@/models';

export function EfficiencyChip({ label, pct }: { label: string; pct?: number }) {
    const color = SEVERITY_COLOR[efficiencySeverity(pct)];
    return (
        <Row gap={4} style={{ padding: '1px 7px', borderRadius: '10px', border: `1px solid ${color}` }}>
            <Text size={11} muted>{label}</Text>
            <Text size={11} weight={600} color={color}>{fmtPct(pct)}</Text>
        </Row>
    );
}

export function MetricRow({ label, value }: { label: string; value: string }) {
    return (
        <Row justify="space-between" gap={12}>
            <Text muted>{label}</Text>
            <Text>{value}</Text>
        </Row>
    );
}

export function RunMetricsView({ metrics }: { metrics?: RunMetrics }) {
    if (!metrics || Object.keys(metrics).length === 0) {
        return <Text muted>No utilization metrics were recorded for this run.</Text>;
    }
    const { cpuEfficiencyPct, memEfficiencyPct, cores, reqMem, maxRss, elapsedSec } = metrics;
    return (
        <Stack gap={4}>
            <Row gap={6} wrap>
                <EfficiencyChip label="CPU" pct={cpuEfficiencyPct} />
                <EfficiencyChip label="Memory" pct={memEfficiencyPct} />
            </Row>
            {cores !== undefined && <MetricRow label="Cores allocated" value={String(cores)} />}
            {elapsedSec !== undefined && <MetricRow label="Elapsed" value={fmtTime(elapsedSec * 1000)} />}
            {(maxRss || reqMem) && <MetricRow label="Memory used / requested" value={`${maxRss ?? '—'} / ${reqMem ?? '—'}`} />}
        </Stack>
    );
}

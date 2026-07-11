import { render } from 'preact';
import { useWebviewState } from '@/ui/platform/vscode';
import { Stack, Row, Text, Card, Icon } from '@/ui/components/base';
import { EfficiencyChip } from '@/ui/components/RunMetricsView';
import type { StatsState, SessionRunRecord } from '@/models';

function RunRow({ run }: { run: SessionRunRecord }) {
    const when = new Date(run.endedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
        <Card>
            <Row justify="space-between" gap={8}>
                <Text weight={600} ellipsis>{run.sessionName}</Text>
                <Text muted size={11}>{when}</Text>
            </Row>
            <Row justify="space-between" gap={8}>
                <Text muted size={11} ellipsis>{run.cluster} · {run.finalStatus}</Text>
                <Row gap={4}>
                    <EfficiencyChip label="CPU" pct={run.metrics?.cpuEfficiencyPct} />
                    <EfficiencyChip label="Mem" pct={run.metrics?.memEfficiencyPct} />
                </Row>
            </Row>
        </Card>
    );
}

function Root() {
    const state = useWebviewState<StatsState>();
    const runs = state?.runs; // already newest-first (SELECT … ORDER BY endedAt DESC)
    if (!runs) { return <Stack pad="8px"><Text muted>Loading…</Text></Stack>; }
    if (runs.length === 0) {
        return <Stack pad="8px"><Text muted>No finished runs yet — utilization appears here once a session ends.</Text></Stack>;
    }
    return (
        <Stack gap={2} pad="6px 8px">
            <Row gap={6} style={{ margin: '2px 0 4px' }}>
                <Icon name="graph" />
                <Text weight={600}>Resource utilization history</Text>
            </Row>
            {runs.map(run => <RunRow key={`${run.cluster}:${run.jobId}`} run={run} />)}
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

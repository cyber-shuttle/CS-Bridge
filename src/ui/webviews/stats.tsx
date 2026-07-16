import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useWebviewState, post } from '@/ui/platform/vscode';
import { Stack, Row, Text, Icon } from '@/ui/components/base';
import { EfficiencyChip } from '@/ui/components/StatsView';
import { groupRunsBySession } from '@/ui/logic/metrics';
import type { StatsState, SessionRunRecord } from '@/models';

function RunItem({ run }: { run: SessionRunRecord }) {
    const when = new Date(run.endedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
        <Row
            justify="space-between"
            gap={8}
            pad="3px 0 3px 22px"
            style={{ cursor: 'pointer' }}
            onClick={() => post({ command: 'openRunSummary', sessionId: run.sessionId, jobId: run.jobId })}
        >
            <Row gap={6} style={{ minWidth: 0 }}>
                <Text size={12} ellipsis>{when}</Text>
                <Text muted size={11} style={{ flexShrink: 0 }}>{run.finalStatus}</Text>
            </Row>
            <Row gap={4} style={{ flexShrink: 0 }}>
                <EfficiencyChip label="CPU" pct={run.stats?.cpuEfficiencyPct} />
                <EfficiencyChip label="Mem" pct={run.stats?.memEfficiencyPct} />
            </Row>
        </Row>
    );
}

function SessionGroup({ runs }: { runs: SessionRunRecord[] }) {
    const [open, setOpen] = useState(true);
    const { sessionName, cluster } = runs[0];
    const runLabel = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
    return (
        <Stack gap={0}>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Text weight={600} ellipsis>{sessionName}</Text>
                <Text muted size={11} style={{ flexShrink: 0 }}>· {cluster}</Text>
                <Text muted size={11} style={{ marginLeft: 'auto', flexShrink: 0 }}>{runLabel}</Text>
            </Row>
            {open && runs.map(run => <RunItem key={`${run.cluster}:${run.jobId}`} run={run} />)}
        </Stack>
    );
}

function Root() {
    const state = useWebviewState<StatsState>();
    const runs = state?.runs;
    if (!runs) { return <Stack pad="8px"><Text muted>Loading…</Text></Stack>; }
    if (runs.length === 0) {
        return <Stack pad="8px"><Text muted>No finished runs yet — utilization appears here once a session ends.</Text></Stack>;
    }
    return (
        <Stack gap={6} pad="4px 8px">
            {groupRunsBySession(runs).map(group => <SessionGroup key={group[0].sessionId} runs={group} />)}
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

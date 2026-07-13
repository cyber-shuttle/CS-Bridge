import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useWebviewState, post } from '@/ui/platform/vscode';
import { Stack, Row, Text, Icon } from '@/ui/components/base';
import { EfficiencyChip } from '@/ui/components/RunMetricsView';
import { groupRunsBySession, type SessionRunGroup } from '@/ui/logic/metrics';
import type { StatsState, SessionRunRecord } from '@/models';

// One finished run: its end time is the row title; clicking opens the session summary; utilization pins to the right.
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
                <EfficiencyChip label="CPU" pct={run.metrics?.cpuEfficiencyPct} />
                <EfficiencyChip label="Mem" pct={run.metrics?.memEfficiencyPct} />
            </Row>
        </Row>
    );
}

// A session groups its runs under a collapsible header (session name * cluster * run count).
function SessionGroup({ group }: { group: SessionRunGroup }) {
    const [open, setOpen] = useState(true);
    const runLabel = `${group.runs.length} run${group.runs.length === 1 ? '' : 's'}`;
    return (
        <Stack gap={0}>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Text weight={600} ellipsis>{group.sessionName}</Text>
                <Text muted size={11} style={{ flexShrink: 0 }}>· {group.cluster}</Text>
                <Text muted size={11} style={{ marginLeft: 'auto', flexShrink: 0 }}>{runLabel}</Text>
            </Row>
            {open && group.runs.map(run => <RunItem key={`${run.cluster}:${run.jobId}`} run={run} />)}
        </Stack>
    );
}

function Root() {
    const state = useWebviewState<StatsState>();
    const runs = state?.runs; // newest-first (getSessionRuns sorts by endedAt desc)
    if (!runs) { return <Stack pad="8px"><Text muted>Loading…</Text></Stack>; }
    if (runs.length === 0) {
        return <Stack pad="8px"><Text muted>No finished runs yet — utilization appears here once a session ends.</Text></Stack>;
    }
    return (
        <Stack gap={6} pad="4px 8px">
            {groupRunsBySession(runs).map(group => <SessionGroup key={group.sessionId} group={group} />)}
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

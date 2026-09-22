import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useWebviewState, post } from '@/ui/platform/vscode';
import { Stack, Row, Text, Icon, Chip } from '@/ui/components/base';
import { EfficiencyChip } from '@/ui/components/StatsView';
import { SectionHeading, SignInPanel } from '@/ui/components/Control';
import { groupRunsBySession } from '@/ui/logic/metrics';
import { fmtTime } from '@/ui/logic/session';
import type { StatsState, SessionRunRecord } from '@/models';
import type { Run } from '@/control/types';

const when = (at: string | number | undefined): string =>
    at === undefined ? '—' : new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function RunItem({ run }: { run: SessionRunRecord }) {
    return (
        <Row
            justify="space-between"
            gap={8}
            pad="3px 0 3px 22px"
            style={{ cursor: 'pointer' }}
            onClick={() => post({ command: 'openRunSummary', sessionId: run.sessionId, jobId: run.jobId })}
        >
            <Row gap={6} style={{ minWidth: 0 }}>
                <Text size={12} ellipsis>{when(run.endedAt)}</Text>
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
    const { cluster, allocation, queue } = runs[0];
    const runLabel = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
    return (
        <Stack gap={0}>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Text weight={600} ellipsis>{cluster}</Text>
                {allocation ? <Chip label={allocation} /> : null}
                {queue ? <Chip label={queue} /> : null}
                <Text muted size={11} style={{ marginLeft: 'auto', flexShrink: 0 }}>{runLabel}</Text>
            </Row>
            {open && runs.map(run => <RunItem key={`${run.cluster}:${run.jobId}`} run={run} />)}
        </Stack>
    );
}

// Slurm's accounting lands a beat after a job ends, so a fresh run carries no stats at all.
function ControlRunItem({ run }: { run: Run }) {
    const stats = run.stats;
    const detail = [
        stats?.elapsedSeconds !== undefined ? fmtTime(stats.elapsedSeconds * 1000) : '',
        stats?.maxRss ? `${stats.maxRss} / ${stats.requestedMemory ?? '—'}` : '',
    ].filter(Boolean).join(' · ');
    return (
        <Stack gap={1} pad="3px 0 3px 22px">
            <Row justify="space-between" gap={8}>
                <Row gap={6} style={{ minWidth: 0 }}>
                    <Text size={12} ellipsis>{run.sessionId} #{run.seq}</Text>
                    <Text muted size={11} style={{ flexShrink: 0 }}>{run.finalState}</Text>
                </Row>
                {stats ? (
                    <Row gap={4} style={{ flexShrink: 0 }}>
                        <EfficiencyChip label="CPU" pct={stats.cpuEfficiencyPct} />
                        <EfficiencyChip label="Mem" pct={stats.memoryEfficiencyPct} />
                    </Row>
                ) : null}
            </Row>
            <Text muted size={11}>{when(run.startedAt)} → {when(run.endedAt)}</Text>
            {detail ? <Text muted size={11}>{detail}</Text> : null}
        </Stack>
    );
}

function ControlRuns({ state }: { state: StatsState }) {
    if (!state.account) { return <SignInPanel note="Sign in to see the runs CyberShuttle recorded for your account." />; }
    if (state.controlError) { return <Text size={12} color="var(--vscode-errorForeground)">{state.controlError}</Text>; }
    if (state.controlRuns.length === 0) { return <Text muted style={{ margin: '4px 0' }}>No CyberShuttle runs yet.</Text>; }
    return (
        <>
            {[...state.controlRuns]
                .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
                .map(run => <ControlRunItem key={`${run.sessionId}:${run.seq}`} run={run} />)}
        </>
    );
}

function Root() {
    const state = useWebviewState<StatsState>();
    if (!state) { return <Stack pad="8px"><Text muted>Loading…</Text></Stack>; }
    return (
        <Stack gap={8} pad="4px 8px">
            <Stack gap={6}>
                {state.runs.length === 0
                    ? <Text muted>No finished runs yet — utilization appears here once a session ends.</Text>
                    : groupRunsBySession(state.runs).map(group => <SessionGroup key={group[0].sessionId} runs={group} />)}
            </Stack>
            <Stack>
                <SectionHeading label="CYBERSHUTTLE RUNS" />
                <ControlRuns state={state} />
            </Stack>
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

import { render } from 'preact';
import { useState } from 'preact/hooks';
import { useWebviewState, post } from '@/ui/platform/vscode';
import { Stack, Row, Text, Icon, Chip, SingleSelect, Option } from '@/ui/components/base';
import { EfficiencyChip } from '@/ui/components/StatsView';
import { groupRunsBySession } from '@/ui/logic/metrics';
import type { StatsState } from '@/models';
import type { PlaneRun } from '@/control';

function RunItem({ run }: { run: PlaneRun }) {
    const when = new Date(run.endedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (
        <Row
            justify="space-between"
            gap={8}
            pad="3px 0 3px 22px"
            style={{ cursor: 'pointer' }}
            onClick={() => post({ command: 'openRunSummary', sessionId: run.sessionId, seq: run.seq })}
        >
            <Row gap={6} style={{ minWidth: 0 }}>
                <Text size={12} ellipsis>{when}</Text>
                <Text muted size={11} style={{ flexShrink: 0 }}>{run.finalState.toLowerCase()}</Text>
            </Row>
            <Row gap={4} style={{ flexShrink: 0 }}>
                <EfficiencyChip label="CPU" pct={run.stats?.cpuEfficiencyPct} />
                <EfficiencyChip label="Mem" pct={run.stats?.memoryEfficiencyPct} />
            </Row>
        </Row>
    );
}

function SessionGroup({ runs }: { runs: PlaneRun[] }) {
    const [open, setOpen] = useState(true);
    const { sshHost: cluster, account: allocation, partition: queue } = runs[0];
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
            {open && runs.map(run => <RunItem key={run.seq} run={run} />)}
        </Stack>
    );
}

// cs-plane records who launched each run: CS Bridge launches as `client`, JupyterLab through cs-plane itself.
const PLATFORMS: Array<[string, string]> = [['', 'All platforms'], ['client', 'VS Code'], ['cs-plane', 'JupyterLab']];

function Root() {
    const state = useWebviewState<StatsState>();
    const [platform, setPlatform] = useState('');
    const runs = state?.runs.filter(run => !platform || run.launcher === platform);
    if (!runs) { return <Stack pad="8px"><Text muted>Loading…</Text></Stack>; }
    return (
        <Stack gap={6} pad="4px 8px">
            <SingleSelect value={platform} onChange={setPlatform}>
                {PLATFORMS.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
            </SingleSelect>
            {runs.length
                ? groupRunsBySession(runs).map(group => <SessionGroup key={group[0].sessionId} runs={group} />)
                : <Text muted>No finished runs yet — utilization appears here once a session ends.</Text>}
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

import { render } from 'preact';
import { useWebviewState } from '@/ui/platform/vscode';
import { Stack, Row, Text, Card, Icon } from '@/ui/components/base';
import { fmtTime, wallMs, elapsedRunMs } from '@/ui/logic/session';
import { StatsView, MetricRow as Field } from '@/ui/components/StatsView';
import { MetricGraphs } from '@/ui/components/MetricGraphs';
import type { SlurmSession, SummaryState } from '@/models';

const STATUS_LABEL: Partial<Record<SlurmSession['status'], string>> = {
    stopped: 'Stopped', failed: 'Failed',
};

function Root() {
    const state = useWebviewState<SummaryState>();
    const s = state?.session;
    if (!s) { return <Stack pad="12px"><Text muted>Loading summary…</Text></Stack>; }
    const gpus = s.gpuCount > 0 ? `${s.gpuCount} × ${s.gpuClass}` : 'None';
    const usedMs = elapsedRunMs(s, Date.now());
    const limitMs = wallMs(s.wallTime);

    return (
        <Stack gap={10} pad="14px 16px" style={{ maxWidth: '640px', margin: '0 auto' }}>
            <Row gap={8} wrap>
                <Icon name="server-environment" />
                <Text size={16} weight={600}>{s.name}</Text>
                <Text muted>· {s.cluster}</Text>
                <Text muted>· {STATUS_LABEL[s.status] ?? s.status}</Text>
            </Row>

            <Card>
                <Text weight={600} style={{ marginBottom: '4px' }}>Resources</Text>
                <Field label="CPUs" value={String(s.cpus)} />
                <Field label="Memory" value={s.memory} />
                <Field label="GPUs" value={gpus} />
                <Field label="Partition" value={s.queue} />
                <Field label="Account" value={s.allocation} />
                <Field label="Run" value={s.jobId} />
            </Card>

            <Card>
                <Text weight={600} style={{ marginBottom: '4px' }}>Wall time</Text>
                <Field label="Used" value={fmtTime(usedMs)} />
                <Field label="Limit" value={limitMs > 0 ? fmtTime(limitMs) : 'No limit'} />
            </Card>

            {state?.metrics?.length ? (
                <Card>
                    <Row gap={6} style={{ marginBottom: '4px' }}>
                        <Icon name="pulse" />
                        <Text weight={600}>Live resource history</Text>
                    </Row>
                    <MetricGraphs history={state.metrics} gpuCount={s.gpuCount} />
                </Card>
            ) : null}

            <Card>
                <Row gap={6} style={{ marginBottom: '4px' }}>
                    <Icon name="graph" />
                    <Text weight={600}>Utilization &amp; efficiency</Text>
                </Row>
                <StatsView stats={state?.stats} />
            </Card>
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

import { render } from 'preact';
import { useWebviewState } from '@/ui/platform/vscode';
import { Stack, Row, Text, Card, Icon } from '@/ui/components/base';
import { fmtTime, wallMs, elapsedRunMs } from '@/ui/logic/session';
import { isTerminal, isWallTimeExpired } from '@/modules/sessionMachine';
import type { SlurmSession } from '@/models';

const STATUS_LABEL: Partial<Record<SlurmSession['status'], string>> = {
    stopped: 'Stopped', completed: 'Completed', failed: 'Failed',
};

// The record may not be terminal yet at summary time: the wall-time path tears down at the deadline,
// ~30s before any sidebar marks it 'stopped' (and a reload demotes 'connected' → 'ready_to_connect').
// So derive the ended-state label rather than trusting the raw status.
function finalStateLabel(s: SlurmSession): string {
    if (isTerminal(s.status)) { return STATUS_LABEL[s.status] ?? s.status; }
    if (isWallTimeExpired(s, Date.now())) { return 'Wall-time reached'; }
    return 'Ended';
}

function Field({ label, value }: { label: string; value: string }) {
    return (
        <Row justify="space-between" gap={12}>
            <Text muted>{label}</Text>
            <Text>{value}</Text>
        </Row>
    );
}

function Root() {
    const s = useWebviewState<SlurmSession>();
    if (!s) { return <Stack pad="12px"><Text muted>Loading summary…</Text></Stack>; }

    const gpus = s.gpuCount > 0 ? `${s.gpuCount} × ${s.gpuClass}` : 'None';
    const usedMs = elapsedRunMs(s, Date.now());
    const limitMs = wallMs(s.wallTime);

    return (
        <Stack gap={10} pad="14px 16px" style={{ maxWidth: '640px' }}>
            <Row gap={8} wrap>
                <Icon name="server-environment" />
                <Text size={16} weight={600}>{s.name}</Text>
                <Text muted>· {s.cluster}</Text>
                <Text muted>· {finalStateLabel(s)}</Text>
            </Row>

            <Card>
                <Text weight={600} style={{ marginBottom: '4px' }}>Resources</Text>
                <Field label="CPUs" value={String(s.cpus)} />
                <Field label="Memory" value={s.memory} />
                <Field label="GPUs" value={gpus} />
                <Field label="Partition" value={s.queue} />
                <Field label="Account" value={s.allocation} />
                <Field label="Job ID" value={s.jobId} />
            </Card>

            <Card>
                <Text weight={600} style={{ marginBottom: '4px' }}>Wall time</Text>
                <Field label="Used" value={fmtTime(usedMs)} />
                <Field label="Limit" value={limitMs > 0 ? fmtTime(limitMs) : 'No limit'} />
            </Card>

            <Card>
                <Row gap={6}>
                    <Icon name="graph" />
                    <Text weight={600}>Utilization &amp; efficiency</Text>
                </Row>
                <Text muted>Detailed CPU/GPU utilization and efficiency over time will appear here once the metrics agent is available.</Text>
            </Card>
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

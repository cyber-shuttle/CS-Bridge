import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { SlurmClusterInfo, HostRuntime } from '@/models';
import { partitionsForTab, hasTab, cpuOptions, memoryOptions, gpuOptions, gpuString, resolvePick, type ResourceTab } from '@/ui/logic/cluster';
import { Row, Stack, Text, Spinner, Button, SingleSelect, Option } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';

export type HostFormInitial = {
    tab?: ResourceTab;
    partName?: string;
    allocation?: string;
    cpu?: string;
    memory?: string;
    gpuCount?: string;
    gpuType?: string;
    wall?: string;
};

interface Props {
    host: string;
    runtime: HostRuntime | undefined;
    initial?: HostFormInitial;
    saveId?: string; // when set, the form edits this session ("Save") instead of creating one ("Add")
    validating?: boolean;
}

const WALL_OPTIONS: [string, string][] = [
    ['00:30:00', '30 min'], ['01:00:00', '1 hour'], ['02:00:00', '2 hours'],
    ['04:00:00', '4 hours'], ['08:00:00', '8 hours'], ['12:00:00', '12 hours'], ['24:00:00', '24 hours'],
];

function Select({ label, value, onChange, options, children }: { label: string; value: string; onChange: (v: string) => void; options?: string[][]; children?: ComponentChildren }) {
    return (
        <Stack gap={2}>
            <Text weight={600} size={12}>{label}</Text>
            <SingleSelect value={value} style={{ width: '100%', maxWidth: 'none' }} onChange={onChange}>
                {options ? options.map(([v, l]) => <Option key={v} value={v}>{l}</Option>) : children}
            </SingleSelect>
        </Stack>
    );
}

function HostFormFields({ host, info, initial, saveId, validating }: { host: string; info: SlurmClusterInfo; initial?: HostFormInitial; saveId?: string; validating?: boolean }) {
    const tabs: ResourceTab[] = (['cpu', 'gpu'] as ResourceTab[]).filter(t => hasTab(info, t));
    const initialTab = initial?.tab ?? tabs[0] ?? 'cpu';
    const initialParts = partitionsForTab(info, initialTab);
    const initialPart = initialParts.find(p => p.name === initial?.partName) ?? initialParts[0];

    const [tab, setTab] = useState<ResourceTab>(initialTab);
    // initialPart, not initial.partName: a partition the cluster dropped would stay selected and still submit.
    const [partName, setPartName] = useState(initialPart?.name ?? '');
    const [allocation, setAllocation] = useState(initial?.allocation ?? info.accounts[0] ?? '');
    const [cpuPick, setCpu] = useState(initial?.cpu ?? '');
    const [memoryPick, setMemory] = useState(initial?.memory ?? '');
    const [gpuCountPick, setGpuCount] = useState(initial?.gpuCount ?? '');
    const [gpuTypePick, setGpuType] = useState(initial?.gpuType ?? '');
    const [wall, setWall] = useState(initial?.wall ?? WALL_OPTIONS[0][0]);

    const parts = partitionsForTab(info, tab);
    const partition = parts.find(p => p.name === partName) ?? parts[0];
    const cpus = cpuOptions(partition).map(String);
    const mems = memoryOptions(partition);
    const gpus = gpuOptions(partition, tab);
    const gpuCounts = gpus.counts.map(String);

    const cpu = resolvePick(cpuPick, cpus, '1');
    const memory = resolvePick(memoryPick, mems, '8 GB');
    const gpuCount = resolvePick(gpuCountPick, gpuCounts, '0');
    const gpuType = resolvePick(gpuTypePick, gpus.types, '');

    const switchTab = (t: ResourceTab) => {
        setTab(t);
        setPartName(partitionsForTab(info, t)[0]?.name ?? '');
    };

    const submit = () => {
        post({
            command: saveId ? 'saveSession' : 'addSession',
            sessionId: saveId,
            host,
            cpus: cpu,
            memory,
            gpu: gpuString(gpuType, parseInt(gpuCount, 10) || 0),
            wallTime: wall,
            queue: partName,
            allocation,
        });
    };

    return (
        <Stack gap={4}>
            {tabs.length > 1
                ? (
                        <Row gap={4}>
                            {tabs.map(t => (
                                <Button key={t} style={{ flex: 1 }} secondary={t !== tab || undefined} onClick={() => switchTab(t)}>{t.toUpperCase()}</Button>
                            ))}
                        </Row>
                    )
                : null}

            {/* '' → (No Allocation): a cluster may expose no accounts to pick (buildSlurmScript then omits --account). */}
            <Select label="Allocation" value={allocation} onChange={setAllocation} options={[['', '(No Allocation)'], ...info.accounts.map(a => [a, a])]} />
            <Select label="Partition" value={partName} onChange={setPartName}>
                {parts.map(p => (
                    <Option key={p.name} value={p.name}>
                        {p.gres.length ? `${p.name} (${p.cpuCount} CPUs, ${p.gres[0].count} GPUs)` : `${p.name} (${p.cpuCount} CPUs)`}
                    </Option>
                ))}
            </Select>
            <Select label="CPUs" value={cpu} onChange={setCpu} options={cpus.map(c => [c, c])} />
            <Select label="Memory" value={memory} onChange={setMemory} options={mems.map(m => [m, m])} />
            {tab === 'gpu' && gpus.counts.length
                ? (
                        <>
                            <Select label="GPUs" value={gpuCount} onChange={setGpuCount} options={gpuCounts.map(n => [n, n])} />
                            <Select label="GPU Type" value={gpuType} onChange={setGpuType} options={gpus.types.map(t => [t, t])} />
                        </>
                    )
                : null}
            <Select label="Wall Time" value={wall} onChange={setWall} options={WALL_OPTIONS} />
            <Button onClick={submit} disabled={validating}>
                {validating ? <Row gap={4}><Spinner size={12} /> Validating…</Row> : (saveId ? 'Save' : 'Add')}
            </Button>
        </Stack>
    );
}

export function HostForm({ host, runtime, initial, saveId, validating }: Props) {
    switch (runtime?.phase) {
        case 'error':
            return (
                <Stack gap={6} pad="8px">
                    <Text color="var(--vscode-errorForeground)">{runtime.message}</Text>
                    <Button onClick={() => post({ command: 'refreshClusterInfo', host })}>Retry</Button>
                </Stack>
            );
        case 'ready':
            return <HostFormFields host={host} info={runtime.info} initial={initial} saveId={saveId} validating={validating} />;
        default: // undefined | loading | awaiting — same spinner; the message says whether it needs you
            return <Row gap={6} pad="8px"><Spinner size={16} /> {runtime?.phase === 'awaiting' ? 'Action needed — check the input box…' : 'Fetching runtime details…'}</Row>;
    }
}

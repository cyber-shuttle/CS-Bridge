import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { SlurmClusterInfo, SlurmPartitionInfo, HostRuntime } from '@/models';
import { partitionsForTab, hasTab, cpuOptions, memoryOptions, gpuOptions, gpuString, type ResourceTab } from '@/ui/logic/cluster';
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
    const [partName, setPartName] = useState(initial?.partName ?? initialPart?.name ?? '');
    const [allocation, setAllocation] = useState(initial?.allocation ?? info.accounts[0] ?? '');
    const [cpu, setCpu] = useState(initial?.cpu ?? String(cpuOptions(initialPart)[0] ?? 1));
    const [memory, setMemory] = useState(initial?.memory ?? memoryOptions(initialPart)[0] ?? '8 GB');
    const [gpuCount, setGpuCount] = useState(initial?.gpuCount ?? String(gpuOptions(initialPart, initialTab).counts[0] ?? 0));
    const [gpuType, setGpuType] = useState(initial?.gpuType ?? gpuOptions(initialPart, initialTab).types[0] ?? '');
    const [wall, setWall] = useState(initial?.wall ?? WALL_OPTIONS[0][0]);

    const parts = partitionsForTab(info, tab);
    const partition = parts.find(p => p.name === partName) ?? parts[0];
    const cpus = cpuOptions(partition);
    const mems = memoryOptions(partition);
    const gpus = gpuOptions(partition, tab);

    // Invariant: selectPartition and switchTab MUST call this to re-default cpu/memory/gpu to the new option lists.
    const applyPartitionDefaults = (p: SlurmPartitionInfo | undefined, t: ResourceTab) => {
        setCpu(String(cpuOptions(p)[0] ?? 1));
        setMemory(memoryOptions(p)[0] ?? '8 GB');
        const g = gpuOptions(p, t);
        setGpuCount(String(g.counts[0] ?? 0));
        setGpuType(g.types[0] ?? '');
    };

    const selectPartition = (name: string) => {
        setPartName(name);
        applyPartitionDefaults(parts.find(p => p.name === name), tab);
    };

    const switchTab = (t: ResourceTab) => {
        setTab(t);
        const np = partitionsForTab(info, t);
        setPartName(np[0]?.name ?? '');
        applyPartitionDefaults(np[0], t);
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

            <Select label="Allocation" value={allocation} onChange={setAllocation} options={info.accounts.map(a => [a, a])} />
            <Select label="Partition" value={partName} onChange={selectPartition}>
                {parts.map(p => (
                    <Option key={p.name} value={p.name}>
                        {p.gres.length ? `${p.name} (${p.cpuCount} CPUs, ${p.gres[0].count} GPUs)` : `${p.name} (${p.cpuCount} CPUs)`}
                    </Option>
                ))}
            </Select>
            <Select label="CPUs" value={cpu} onChange={setCpu} options={cpus.map(c => [String(c), String(c)])} />
            <Select label="Memory" value={memory} onChange={setMemory} options={mems.map(m => [m, m])} />
            {tab === 'gpu' && gpus.counts.length
                ? (
                        <>
                            <Select label="GPUs" value={gpuCount} onChange={setGpuCount} options={gpus.counts.map(n => [String(n), String(n)])} />
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
                    <Button onClick={() => post({ command: 'retryClusterInfo', host })}>Retry</Button>
                </Stack>
            );
        case 'ready':
            return <HostFormFields host={host} info={runtime.info} initial={initial} saveId={saveId} validating={validating} />;
        default: // undefined | loading | awaiting — same spinner; the message says whether it needs you
            return <Row gap={6} pad="8px"><Spinner size={16} /> {runtime?.phase === 'awaiting' ? 'Action needed — check the input box…' : 'Fetching runtime details…'}</Row>;
    }
}

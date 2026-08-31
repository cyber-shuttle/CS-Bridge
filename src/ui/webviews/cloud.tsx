import { ComponentChildren, render } from "preact";
import { Stack, Text, Button, Row, Icon } from "@/ui/components/base";
import { post, useWebviewState } from "@/ui/platform/vscode";
import { AWSInstanceInfo, CloudProviderState } from "@/models";
import { useState } from "preact/hooks";

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <Row gap={6} style={{ alignItems: 'baseline' }}>
            <Text muted size={11} style={{ width: 64, flexShrink: 0 }}>{label}</Text>
            <div style={{ minWidth: 0, fontSize: '12px', wordBreak: 'break-all' }}>{children}</div>
        </Row>
    );
}

function InstanceItem({ instance: instance }: { instance: AWSInstanceInfo }) {
    const [open, setOpen] = useState(false);
    return (
        <Stack>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Text weight={600} ellipsis>{instance.name}</Text>
            </Row>
            {open ? (
                <Stack gap={4} pad="0 0 6px 22px">
                    <DetailRow label="ID">{instance.instanceID ?? '—'}</DetailRow>
                    <DetailRow label="Type">{instance.instanceType ?? '—'}</DetailRow>
                    <DetailRow label="State">{instance.state ?? '—'}</DetailRow>
                    {/* zoom 0.85 matches the Sessions-view action buttons (e.g. Connect). */}
                    <Row gap={6} justify="flex-end" pad="2px 0 0" style={{ zoom: 0.85 }}>
                        <Button icon="terminal" onClick={() => post({ command: 'openTerminal', name: instance.instanceID })}>Terminal</Button>
                        <Button icon="trash" onClick={() => post({ command: 'removeSshHost', name: instance.instanceID })}>Stop</Button>
                    </Row>
                </Stack>
            ) : null}
        </Stack>
    );
}

function InstanceList({ state }: { state: CloudProviderState }) {
    const instances = [...state.instances].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    if (instances.length === 0) { return <Text muted style={{ margin: '4px 0' }}>No Instances yet.</Text>; }
    return <>{instances.map(host => <InstanceItem key={host.name} instance={host} />)}</>;
}

function Root() {
    const state = useWebviewState<CloudProviderState>();
    return state ? (
        <Stack
            gap={10}
            pad="14px 16px"
            style={{ maxWidth: "640px", margin: "0 auto" }}
        >
            <Button
                onClick={() => {
                    post({ command: "launch" });
                }}
            // disabled={state.accessKey == "" && state.secretKey === ""}
            >
                Launch EC2 Instance
            </Button>
            <Button
                onClick={() => {
                    post({ command: "rm-key-pair" });
                }}
            // disabled={state.accessKey == "" && state.secretKey === ""}
            >
                Remove Key Pair
            </Button>

            <InstanceList state={state} />

        </Stack>
    ) : null;
}

render(<Root />, document.getElementById("root")!);

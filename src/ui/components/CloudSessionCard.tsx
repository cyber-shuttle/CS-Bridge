import { Row, Stack, Text, Card, ActionIcon, Button, Chip } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';
import { CloudInstanceInfo } from '@/models';
import type { CSSProperties } from 'preact';

const statusStyle: CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: '12px', flexWrap: 'wrap', minWidth: 0 };
export function CloudSessionCard({ instance: instance }: { instance: CloudInstanceInfo }) {
    // const { statusColor, canClose, actions } = statusDescriptor(session);
    // const status = STATUS_ICON[session.status];
    //
    // const act = (a: SessionAction) => {
    //     const command = COMMAND_FOR[a.kind];
    //     if (command) { post({ command, sessionId: session.id }); 
    // };

    return (
        <Card>
            {/* Fixed height keeps the gap to the detail row constant whether or not the close button shows. */}
            <Row gap={6} style={{ minHeight: '20px' }}>
                {/* <vscode-icon name={status.name} spin={status.spin || undefined} style={{ color: statusColor, flexShrink: 0, marginRight: '-3px' }}></vscode-icon> */}
                <Text weight={600}>{instance.name}</Text>
                <Chip label={instance.instanceType ?? ""} />
                <Row gap={4} style={{ marginLeft: 'auto' }}>
                    {instance.state !== "terminated" && <ActionIcon name="close" ariaLabel="Remove Instance" size={14} onClick={() => post({ command: 'removeCloudInstance', instanceId: instance.instanceID, instanceName: instance.name })} />}
                </Row>
            </Row>
            <div style={{ borderTop: '1px solid var(--vscode-panel-border)', marginBottom: '3px' }} />
            <Stack gap={6}>
                {/* <ResourceStats session={session} /> */}
                <Row gap={6}>
                    <Chip label={instance.publicIp ?? ""} />
                    <Row style={statusStyle}>{instance.state}</Row>
                    <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0, zoom: 0.85 }}>
                        {instance.state === "running" && <Button icon="terminal" onClick={() => post({ command: 'sshIntoCloudInstance', instanceIp: instance.publicIp })}>Terminal</Button>}
                        {instance.state === "running" && <Button icon="remote" onClick={() => post({ command: 'startRemoteForloudInstance', instanceName: instance.name, instanceIp: instance.publicIp, instanceId: instance.instanceID })}>Remote</Button>}
                        {instance.state === "running" && <Button icon="stop" onClick={() => post({ command: 'stopCloudInstance', instanceId: instance.instanceID })}>Stop</Button>}
                        {instance.state === "stopped" && <Button icon="play" onClick={() => post({ command: 'restartCloudInstance', instanceId: instance.instanceID })}>Start</Button>}
                    </Row>
                </Row>
            </Stack>
        </Card>
    );
}

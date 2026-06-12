import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { CSSProperties } from 'preact';
import type { ViewSession } from '@/models';
import { statusDescriptor, remainingMs, fmtTime, wallMs, type SessionAction } from '@/ui/logic/session';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';

interface Props {
    session: ViewSession;
    readonly?: boolean;
}

// The 1s clock: the Sessions root owns `now` and feeds it through this provider; StatusText reads it.
export const NowContext = createContext(Date.now());
const useNow = () => useContext(NowContext);

const COMMAND_FOR: Record<SessionAction['kind'], string | null> = {
    start: 'prepareLaunchSession',
    restart: 'prepareLaunchSession',
    stop: 'cancelSessionExecution',
    switch: 'connectTunnel',
    connect: 'connectTunnel',
    current: null,
};

const STATUS_ICON: Record<ViewSession['status'], { name: string; spin?: boolean }> = {
    not_started: { name: 'circle-slash' },
    configuring: { name: 'loading', spin: true },
    deploying_agent: { name: 'loading', spin: true },
    submitting: { name: 'loading', spin: true },
    pending: { name: 'loading', spin: true },
    running: { name: 'loading', spin: true },
    ready_to_connect: { name: 'plug' },
    connecting: { name: 'loading', spin: true },
    connected: { name: 'vm-active' },
    connection_broken: { name: 'loading', spin: true },
    completed: { name: 'pass' },
    failed: { name: 'error' },
    cancelled: { name: 'circle-slash' },
    cancelling: { name: 'loading', spin: true },
    expired: { name: 'history' },
};

const statusStyle: CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: '12px', flexWrap: 'wrap', minWidth: 0 };

function StatusText({ session }: { session: ViewSession }) {
    const now = useNow();
    const s = session.status;
    switch (s) {
        case 'not_started': return <Row style={statusStyle}>Not started</Row>;
        case 'ready_to_connect':
        case 'connected': return <Row style={statusStyle}>{fmtTime(remainingMs(session, now))} left</Row>;
        case 'running': return <Row style={statusStyle}>Setting up connection…</Row>;
        case 'connection_broken': return <Row style={statusStyle}>Reconnecting…</Row>;
        case 'connecting': return <Row style={statusStyle}>Connecting…</Row>;
        case 'deploying_agent': return <Row style={statusStyle}>Deploying agent…</Row>;
        case 'submitting': return <Row style={statusStyle}>Submitting…</Row>;
        case 'configuring': return <Row style={statusStyle}>Configuring…</Row>;
        case 'pending': {
            const secs = session.submittedAt ? Math.floor((now - session.submittedAt) / 1000) : 0;
            const elapsed = secs >= 60 ? ` (${Math.floor(secs / 60)}m ${secs % 60}s)` : ` (${secs}s)`;
            return <Row style={statusStyle}>Queued{session.submittedAt ? elapsed : ''}</Row>;
        }
        case 'cancelling': return <Row style={statusStyle}>Stopping…</Row>;
        case 'cancelled': return <Row style={statusStyle}>{session.errorMessage ? `Cancel failed: ${session.errorMessage}` : 'Cancelled'}</Row>;
        case 'failed': return <Row style={statusStyle}><Text title={session.errorMessage || undefined}>{session.errorMessage ? `Failed: ${session.errorMessage}` : 'Failed'}</Text></Row>;
        case 'completed': return <Row style={statusStyle}>Completed</Row>;
        case 'expired': return <Row style={statusStyle}>Expired</Row>;
        default: return null;
    }
}

export function SessionCard({ session, readonly }: Props) {
    const { dot, canClose, actions } = statusDescriptor(session);
    const status = STATUS_ICON[session.status];
    const sep = <Text style={{ opacity: 0.4, margin: '0 2px' }}>|</Text>;

    const act = (a: SessionAction) => {
        const command = COMMAND_FOR[a.kind];
        if (command) { post({ command, sessionId: session.id }); }
    };

    return (
        <Card>
            {/* Fixed-height title row so the gap to the detail row is identical whether or not the close button shows. */}
            <Row gap={6} style={{ minHeight: '20px' }}>
                <vscode-icon name={status.name} spin={status.spin || undefined} style={{ color: dot, flexShrink: 0 }}></vscode-icon>
                <Text weight={600}>{session.cluster}</Text>
                {session.jobDirectory ? <Text muted size={11} ellipsis>{session.jobDirectory}</Text> : null}
                {!readonly && canClose ? <ActionIcon name="close" ariaLabel="Close session" size={14} onClick={() => post({ command: 'removeSession', sessionId: session.id })} /> : null}
            </Row>
            <Stack gap={3}>
                <Row gap={3} wrap style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>
                    <Icon name="account" /> {session.allocation} {sep}
                    <Icon name="server-environment" /> {session.queue} {sep}
                    <Icon name="vm" /> {session.cpus} {sep}
                    <Icon name="database" /> {session.memory}
                    {session.gpuClass !== 'None' ? <>{sep} <Icon name="circuit-board" /> {session.gpuClass}</> : null}
                    {sep} <Icon name="watch" /> {fmtTime(wallMs(session.wallTime))}
                </Row>
                <Row gap={8} justify="space-between">
                    <StatusText session={session} />
                    {!readonly && actions.length ? (
                        <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            {actions.map(a => (
                                <Button key={a.kind} icon={a.icon} disabled={a.kind === 'current' || undefined} onClick={() => act(a)}>{a.label}</Button>
                            ))}
                        </Row>
                    ) : null}
                </Row>
            </Stack>
        </Card>
    );
}

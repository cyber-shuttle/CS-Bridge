import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { CSSProperties } from 'preact';
import type { ViewSession } from '@/models';
import { statusDescriptor, remainingMs, fmtTime, wallMs, type SessionAction } from '@/ui/logic/session';
import { Row, Stack, Text, Card, ActionIcon, Button } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';

interface Props {
    session: ViewSession;
    readonly?: boolean;
}

// 1s clock owned by the Sessions root, fed through this context so StatusText re-renders each tick.
export const NowContext = createContext(Date.now());
const useNow = () => useContext(NowContext);

const COMMAND_FOR: Record<SessionAction['kind'], string | null> = {
    start: 'prepareLaunchSession',
    restart: 'prepareLaunchSession',
    stop: 'stopSessionExecution',
    switch: 'connectTunnel',
    connect: 'connectTunnel',
    current: null,
};

const STATUS_ICON: Record<ViewSession['status'], { name: string; spin?: boolean }> = {
    not_started: { name: 'circle-outline' },
    submitting: { name: 'loading', spin: true },
    queued: { name: 'loading', spin: true },
    preparing: { name: 'loading', spin: true },
    ready_to_connect: { name: 'plug' },
    connecting: { name: 'loading', spin: true },
    connected: { name: 'vm-active' },
    unreachable: { name: 'warning' },
    completed: { name: 'pass' },
    failed: { name: 'error' },
    stopped: { name: 'debug-stop' },
    stopping: { name: 'loading', spin: true },
    awaiting_input: { name: 'loading', spin: true },
    interrupted: { name: 'warning' },
};

const statusStyle: CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: '12px', flexWrap: 'wrap', minWidth: 0 };

const chipStyle: CSSProperties = { padding: '1px 6px', borderRadius: '4px', background: 'var(--vscode-keybindingLabel-background)', color: 'var(--vscode-keybindingLabel-foreground)', border: '1px solid var(--vscode-keybindingLabel-border)', fontSize: '11px', whiteSpace: 'nowrap' };

type ChipData = { label: string; title?: string };

function Chip({ label, title }: ChipData) {
    return <span title={title} style={chipStyle}>{label}</span>;
}

function ChipRow({ chips }: { chips: ChipData[] }) {
    return <Row gap={4} wrap>{chips.map(c => <Chip key={c.label} {...c} />)}</Row>;
}

function StatusText({ session }: { session: ViewSession }) {
    const now = useNow();
    const s = session.status;
    switch (s) {
        case 'not_started': return <Row style={statusStyle}>Not started</Row>;
        case 'ready_to_connect':
        case 'connected': return <Row style={statusStyle}>{fmtTime(remainingMs(session, now))} left</Row>;
        case 'preparing': return <Row style={statusStyle}>Establishing secure tunnel…</Row>;
        case 'unreachable': return <Row style={statusStyle}><Text title={session.errorMessage || undefined}>{session.errorMessage ? `Unreachable: ${session.errorMessage}` : 'Cluster unreachable — retrying…'}</Text></Row>;
        case 'connecting': return <Row style={statusStyle}>Connecting…</Row>;
        case 'submitting': return <Row style={statusStyle}>Submitting…</Row>;
        case 'awaiting_input': return <Row style={statusStyle}>Action needed — check the input box…</Row>;
        case 'queued': {
            const secs = session.submittedAt ? Math.floor((now - session.submittedAt) / 1000) : 0;
            const elapsed = secs >= 60 ? ` (${Math.floor(secs / 60)}m ${secs % 60}s)` : ` (${secs}s)`;
            return <Row style={statusStyle}>Queued{session.submittedAt ? elapsed : ''}</Row>;
        }
        case 'stopping': return <Row style={statusStyle}>Stopping…</Row>;
        case 'stopped': return <Row style={statusStyle}>{session.errorMessage ? `Stop failed: ${session.errorMessage}` : 'Stopped'}</Row>;
        case 'failed': return <Row style={statusStyle}><Text title={session.errorMessage || undefined}>{session.errorMessage ? `Failed: ${session.errorMessage}` : 'Failed'}</Text></Row>;
        case 'interrupted': return <Row style={statusStyle}>Interrupted — input dismissed</Row>;
        case 'completed': return <Row style={statusStyle}>Completed</Row>;
        default: return null;
    }
}

export function SessionCard({ session, readonly }: Props) {
    const { statusColor, canClose, actions } = statusDescriptor(session);
    const status = STATUS_ICON[session.status];

    const act = (a: SessionAction) => {
        const command = COMMAND_FOR[a.kind];
        if (command) { post({ command, sessionId: session.id }); }
    };

    const resources: ChipData[] = [
        { label: `${session.cpus} CPU` },
        { label: `${session.gpuCount} GPU`, title: session.gpuClass !== 'None' ? session.gpuClass : undefined },
        { label: session.memory },
    ].filter(c => c.label);

    return (
        <Card>
            {/* Fixed height keeps the gap to the detail row constant whether or not the close button shows. */}
            <Row gap={6} style={{ minHeight: '20px' }}>
                <vscode-icon name={status.name} spin={status.spin || undefined} style={{ color: statusColor, flexShrink: 0 }}></vscode-icon>
                <Text weight={600}>{session.cluster}</Text>
                <Chip label={session.allocation} />
                <Chip label={session.queue} />
                {session.jobDirectory ? <Text muted size={11} ellipsis>{session.jobDirectory}</Text> : null}
                {!readonly && canClose
                    ? (
                            <Row gap={4} style={{ marginLeft: 'auto' }}>
                                <ActionIcon name="edit" ariaLabel="Edit session" size={14} onClick={() => post({ command: 'editSession', sessionId: session.id })} />
                                <ActionIcon name="close" ariaLabel="Close session" size={14} onClick={() => post({ command: 'removeSession', sessionId: session.id })} />
                            </Row>
                        )
                    : null}
            </Row>
            <div style={{ borderTop: '1px solid var(--vscode-panel-border)', marginBottom: '3px' }} />
            <Stack gap={6}>
                <ChipRow chips={resources} />
                <Row gap={6}>
                    <Chip label={fmtTime(wallMs(session.wallTime))} />
                    <StatusText session={session} />
                    {!readonly && actions.length ? (
                        // zoom shrinks the label and the vscode-button's fixed-size codicon together.
                        <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0, zoom: 0.85 }}>
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

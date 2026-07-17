import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { CSSProperties, VNode } from 'preact';
import { METRICS_HISTORY_LEN, type ViewSession } from '@/models';
import { statusDescriptor, remainingMs, fmtTime, wallMs, elapsedLabel, type SessionAction } from '@/ui/logic/session';
import { isRelayLive } from '@/modules/sessionMachine';
import { Row, Stack, Text, Card, ActionIcon, Button, Spinner, Chip } from '@/ui/components/base';
import { Sparkline } from '@/ui/components/Sparkline';
import { metricGraphs, graphTitle } from '@/ui/components/MetricGraphs';
import { post } from '@/ui/platform/vscode';

interface Props {
    session: ViewSession;
    readonly?: boolean;
    dev?: boolean;
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
    opening: null,
};

const STATUS_ICON: Record<ViewSession['status'], { name: string; spin?: boolean }> = {
    // Bare-minimum glyph vocabulary — a dot at rest, a spinner in progress, a triangle for trouble;
    // dotColor() carries the state distinction (grey idle · green live · yellow needs-action · orange error).
    not_started: { name: 'circle-outline' },
    submitting: { name: 'loading', spin: true },
    queued: { name: 'loading', spin: true },
    preparing: { name: 'loading', spin: true },
    ready_to_connect: { name: 'circle-filled' },
    connecting: { name: 'loading', spin: true },
    connected: { name: 'circle-filled' },
    unreachable: { name: 'primitive-square' },
    failed: { name: 'primitive-square' },
    stopped: { name: 'primitive-square' },
    stopping: { name: 'loading', spin: true },
    awaiting_input: { name: 'primitive-square' },
};

const statusStyle: CSSProperties = { color: 'var(--vscode-descriptionForeground)', fontSize: '12px', flexWrap: 'wrap', minWidth: 0 };

const sepStyle: CSSProperties = { width: '1px', alignSelf: 'stretch', background: 'var(--vscode-descriptionForeground)', opacity: 0.45 };

// Lay items in a row divided by vertical separators, one before the first and after the last too.
function Divided({ items }: { items: VNode[] }) {
    return (
        <Row gap={8} wrap style={{ alignItems: 'stretch' }}>
            {items.flatMap((c, i) => [<div key={`sep${i}`} style={sepStyle} />, c]).concat(<div key="sepEnd" style={sepStyle} />)}
        </Row>
    );
}

// Raw resource text (e.g. "MEM: 2G", "CPU: 1", "GPU: 1") above each live sparkline when relay-live; a plain row
// otherwise. Columns bracketed by vertical separators.
function ResourceStats({ session }: { session: ViewSession }) {
    const mem = session.memory.replace(/\s+/g, '').replace(/B$/i, '');
    const textOf: Record<string, string> = { MEM: `MEM: ${mem}`, CPU: `CPU: ${session.cpus}`, GPU: `GPU: ${session.gpuCount}`, GPU0: `GPU: ${session.gpuCount}` };
    if (!isRelayLive(session.status)) {
        return <Divided items={['MEM', 'CPU', 'GPU'].map(k => <Text key={k} size={11}>{textOf[k]}</Text>)} />;
    }
    return (
        <Divided items={metricGraphs(session.metrics ?? [], session.gpuCount).map(g => (
            <Stack key={g.label} gap={1} style={{ minWidth: '44px', alignItems: 'flex-start' }}>
                <Text size={11}>{textOf[g.label] ?? g.label}</Text>
                {g.lines[0].values.length >= 2
                    ? <Sparkline lines={g.lines} slots={METRICS_HISTORY_LEN} title={graphTitle(g)} />
                    : <div style={{ height: '14px' }} />}
            </Stack>
        ))}
        />
    );
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
        case 'queued':
            return <Row style={statusStyle}>Queued{session.submittedAt ? ` (${elapsedLabel(session.submittedAt, now)})` : ''}</Row>;
        case 'stopping': return <Row style={statusStyle}>Stopping…</Row>;
        case 'stopped': return <Row style={statusStyle}>{session.errorMessage ? `Stop failed: ${session.errorMessage}` : 'Stopped'}</Row>;
        case 'failed': return <Row style={statusStyle}><Text title={session.errorMessage || undefined}>{session.errorMessage ? `Failed: ${session.errorMessage}` : 'Failed'}</Text></Row>;
        default: return null;
    }
}

export function SessionCard({ session, readonly, dev }: Props) {
    const { statusColor, canClose, actions } = statusDescriptor(session);
    const status = STATUS_ICON[session.status];

    const act = (a: SessionAction) => {
        const command = COMMAND_FOR[a.kind];
        if (command) { post({ command, sessionId: session.id }); }
    };

    return (
        <Card>
            {/* Fixed height keeps the gap to the detail row constant whether or not the close button shows. */}
            <Row gap={6} style={{ minHeight: '20px' }}>
                <vscode-icon name={status.name} spin={status.spin || undefined} style={{ color: statusColor, flexShrink: 0, marginRight: '-3px' }}></vscode-icon>
                <Text weight={600}>{session.cluster}</Text>
                <Chip label={session.allocation} />
                <Chip label={session.queue} />
                {session.jobDirectory ? <Text muted size={11} ellipsis>{session.jobDirectory}</Text> : null}
                {!readonly && (dev || canClose)
                    ? (
                            <Row gap={4} style={{ marginLeft: 'auto' }}>
                                {dev ? <ActionIcon name="circle-filled" ariaLabel="Check linkspan" title="Check linkspan availability (dev)" size={14} onClick={() => post({ command: 'pingLinkspan', sessionId: session.id })} /> : null}
                                {canClose ? <ActionIcon name="edit" ariaLabel="Edit session" size={14} onClick={() => post({ command: 'editSession', sessionId: session.id })} /> : null}
                                {canClose ? <ActionIcon name="close" ariaLabel="Close session" size={14} onClick={() => post({ command: 'removeSession', sessionId: session.id })} /> : null}
                            </Row>
                        )
                    : null}
            </Row>
            <div style={{ borderTop: '1px solid var(--vscode-panel-border)', marginBottom: '3px' }} />
            <Stack gap={6}>
                <ResourceStats session={session} />
                <Row gap={6}>
                    <Chip label={fmtTime(wallMs(session.wallTime))} />
                    <StatusText session={session} />
                    {!readonly && actions.length ? (
                        // zoom shrinks the label and the vscode-button's fixed-size codicon together.
                        <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0, zoom: 0.85 }}>
                            {actions.map(a => a.kind === 'opening'
                                ? <Button key={a.kind} disabled><Row gap={4}><Spinner size={11} /> {a.label}</Row></Button>
                                : <Button key={a.kind} icon={a.icon} disabled={a.kind === 'current' || undefined} onClick={() => act(a)}>{a.label}</Button>)}
                        </Row>
                    ) : readonly && actions.some(a => a.kind === 'stop') ? (
                        <Row gap={6} style={{ marginLeft: 'auto', flexShrink: 0, zoom: 0.85 }}>
                            <Button icon="debug-stop" onClick={() => post({ command: 'stopRemoteSession', sessionId: session.id })}>Stop</Button>
                        </Row>
                    ) : null}
                </Row>
            </Stack>
        </Card>
    );
}

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SessionsState, ViewSession, HostRuntime } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { SessionCard, NowContext } from '@/ui/components/SessionCard';
import { HostForm, type HostFormInitial } from '@/ui/components/HostForm';
import { parseGpuClass } from '@/ui/logic/cluster';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button } from '@/ui/components/base';

function ConfigCard({ icon, muted, host, runtime, onDismiss, initial, saveId, validating }: {
    icon: string; muted?: boolean; host: string; runtime: HostRuntime | undefined;
    onDismiss: () => void; initial?: HostFormInitial; saveId?: string; validating?: boolean;
}) {
    return (
        <Card>
            <Row gap={6}>
                <Icon name={icon} style={muted ? { color: 'var(--vscode-descriptionForeground)' } : undefined} />
                <Text weight={600}>{host}</Text>
                <ActionIcon name="close" ariaLabel="Dismiss" onClick={onDismiss} />
            </Row>
            <HostForm host={host} runtime={runtime} initial={initial} saveId={saveId} validating={validating} />
        </Card>
    );
}

function gpuInitial(gpuClass: string): Partial<HostFormInitial> {
    const gpu = parseGpuClass(gpuClass);
    return gpu ? { tab: 'gpu', gpuType: gpu.gpuType, gpuCount: gpu.gpuCount } : { tab: 'cpu' };
}

function editInitial(session: ViewSession): HostFormInitial {
    return {
        ...gpuInitial(session.gpuClass),
        partName: session.queue,
        allocation: session.allocation,
        cpu: String(session.cpus),
        memory: session.memory,
        wall: session.wallTime,
    };
}

function ScriptPreviewOverlay({ state }: { state: SessionsState }) {
    const s = state.previewSession;
    if (!s) { return null; }
    return (
        <Stack gap={8} pad="12px" style={{ position: 'fixed', inset: 0, background: 'var(--vscode-editor-background)', zIndex: 10 }}>
            <Text weight={600}>SLURM Job Script Preview</Text>
            <Text muted>Host: {s.cluster}</Text>
            <Text block style={{ flex: 1, overflow: 'auto', whiteSpace: 'pre', fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px', background: 'var(--vscode-textCodeBlock-background)', padding: '8px', borderRadius: '4px' }}>{s.batchScript ?? ''}</Text>
            <Row gap={8} justify="flex-end">
                <Button secondary onClick={() => post({ command: 'dismissPreview' })}>Close</Button>
                <Button onClick={() => post({ command: 'launchSession', sessionId: s.id })}>Submit Job</Button>
            </Row>
        </Stack>
    );
}

function AlertOverlay({ alert }: { alert: NonNullable<SessionsState['alert']> }) {
    return (
        <Row style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.4)', zIndex: 20, justifyContent: 'center' }}>
            <Stack gap={8} pad="12px" style={{ flex: 1, margin: '12px', maxHeight: '85%', background: 'var(--vscode-editorWidget-background)', border: '1px solid var(--vscode-editorWidget-border)', borderRadius: '4px' }}>
                <Row gap={6}>
                    <Icon name="error" style={{ color: 'var(--vscode-errorForeground)' }} />
                    <Text weight={600}>{alert.title}</Text>
                </Row>
                <Text block style={{ overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px', background: 'var(--vscode-textCodeBlock-background)', padding: '8px', borderRadius: '4px' }}>{alert.message}</Text>
                <Row gap={8} justify="flex-end">
                    <Button onClick={() => post({ command: 'dismissAlert' })}>Dismiss</Button>
                </Row>
            </Stack>
        </Row>
    );
}

function SessionsView({ state }: { state: SessionsState }) {
    if (state.isRemote) {
        const session = state.sessions[0];
        return session
            ? <SessionCard key={session.id} session={session} readonly />
            : <Text muted style={{ margin: '2px 0' }}>No active session.</Text>;
    }
    return (
        <>
            {state.draftHost ? <ConfigCard key={state.draftHost} icon="circle-outline" muted host={state.draftHost} runtime={state.hostRuntime[state.draftHost]} onDismiss={() => post({ command: 'dismissDraftSession' })} validating={state.validating} /> : null}
            {state.sessions.map(s => s.id === state.editingId
                ? <ConfigCard key={s.id} icon="edit" host={s.cluster} runtime={state.hostRuntime[s.cluster]} onDismiss={() => post({ command: 'dismissEditSession' })} initial={editInitial(s)} saveId={s.id} validating={state.validating} />
                : <SessionCard key={s.id} session={s} dev={state.developerMode} />)}
            {!state.sessions.length && !state.draftHost
                ? <Text muted block style={{ margin: '4px', textAlign: 'center' }}>No sessions yet. Click on + to create one.</Text>
                : null}
            <ScriptPreviewOverlay state={state} />
            {state.alert ? <AlertOverlay alert={state.alert} /> : null}
        </>
    );
}

function Root() {
    const state = useWebviewState<SessionsState>();
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    return state
        ? <NowContext.Provider value={now}><Stack pad="8px"><SessionsView state={state} /></Stack></NowContext.Provider>
        : null;
}

render(<Root />, document.getElementById('root')!);

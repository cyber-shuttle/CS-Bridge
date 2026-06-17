import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SessionsState, ViewSession, HostRuntime } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { SessionCard, NowContext } from '@/ui/components/SessionCard';
import { HostForm, type HostFormInitial } from '@/ui/components/HostForm';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button } from '@/ui/components/base';

function ConfigCard({ icon, muted, host, runtime, onDismiss, initial, saveId }: {
    icon: string; muted?: boolean; host: string; runtime: HostRuntime | undefined;
    onDismiss: () => void; initial?: HostFormInitial; saveId?: string;
}) {
    return (
        <Card>
            <Row gap={6}>
                <Icon name={icon} style={muted ? { color: 'var(--vscode-descriptionForeground)' } : undefined} />
                <Text weight={600}>{host}</Text>
                <ActionIcon name="close" ariaLabel="Dismiss" onClick={onDismiss} />
            </Row>
            <HostForm host={host} runtime={runtime} initial={initial} saveId={saveId} />
        </Card>
    );
}

// gpuClass is gpuString output ("type:count" | "count" | "None"); split it back into form fields.
function gpuInitial(gpuClass: string): Partial<HostFormInitial> {
    if (!gpuClass || gpuClass === 'None') { return { tab: 'cpu' }; }
    const [type, count] = gpuClass.split(':');
    return count ? { tab: 'gpu', gpuType: type, gpuCount: count } : { tab: 'gpu', gpuCount: type };
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

function SessionsView({ state }: { state: SessionsState }) {
    if (state.isRemote) {
        const session = state.sessions[0];
        return (
            <>
                {session
                    ? <SessionCard key={session.id} session={session} readonly />
                    : <Text muted style={{ margin: '2px 0' }}>No active session.</Text>}
            </>
        );
    }
    return (
        <>
            {state.draftHost ? <ConfigCard key={state.draftHost} icon="circle-outline" muted host={state.draftHost} runtime={state.hostRuntime[state.draftHost]} onDismiss={() => post({ command: 'dismissDraftSession' })} /> : null}
            {state.sessions.map(s => s.id === state.editingId
                ? <ConfigCard key={s.id} icon="edit" host={s.cluster} runtime={state.hostRuntime[s.cluster]} onDismiss={() => post({ command: 'dismissEditSession' })} initial={editInitial(s)} saveId={s.id} />
                : <SessionCard key={s.id} session={s} />)}
            {!state.sessions.length && !state.draftHost
                ? <Text muted block style={{ margin: '4px', textAlign: 'center' }}>No sessions yet. Click on + to create one.</Text>
                : null}
            <ScriptPreviewOverlay state={state} />
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

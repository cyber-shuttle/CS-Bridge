import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SessionsState } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { SessionCard, NowContext } from '@/ui/components/SessionCard';
import { HostForm } from '@/ui/components/HostForm';
import { Row, Stack, Text, Card, Icon, ActionIcon, Button } from '@/ui/components/base';

function AccountLine({ state, readonly }: { state: SessionsState; readonly?: boolean }) {
    const { account } = state;
    return (
        <Row gap={6} pad="6px 0">
            <Icon name="account" />
            <Text ellipsis color={account.label ? undefined : 'var(--vscode-errorForeground)'}>{account.label ?? 'Not signed in'}</Text>
            {!readonly ? (
                <Button style={{ marginLeft: 'auto' }} onClick={() => post({ command: 'switchAuth' })}>
                    {account.label ? 'Switch' : 'Sign in'}
                </Button>
            ) : null}
        </Row>
    );
}

function DraftCard({ state }: { state: SessionsState }) {
    const host = state.draftHost!;
    return (
        <Card>
            <Row gap={6}>
                <Icon name="add" />
                <Text weight={600}>{host}</Text>
                <ActionIcon name="close" ariaLabel="Cancel new session" onClick={() => post({ command: 'cancelDraftSession' })} />
            </Row>
            <HostForm host={host} info={state.clusterInfo[host]} error={state.clusterErrors[host]} />
        </Card>
    );
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
                <Button secondary onClick={() => post({ command: 'dismissPreview' })}>Cancel</Button>
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
                <AccountLine state={state} readonly />
                {session
                    ? <SessionCard key={session.id} session={session} readonly />
                    : <Text muted style={{ margin: '2px 0' }}>No active session.</Text>}
            </>
        );
    }
    return (
        <>
            <AccountLine state={state} />
            {state.draftHost ? <DraftCard key={state.draftHost} state={state} /> : null}
            {state.sessions.map(s => <SessionCard key={s.id} session={s} />)}
            {!state.sessions.length && !state.draftHost
                ? <Text muted style={{ margin: '2px 0' }}>No sessions yet — use + above.</Text>
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
        ? <NowContext.Provider value={now}><Stack pad="4px 8px"><SessionsView state={state} /></Stack></NowContext.Provider>
        : null;
}

render(<Root />, document.getElementById('root')!);

import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { HostsState, SshHost } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { Row, Stack, Text, Icon, Button } from '@/ui/components/base';

const SOURCE_ICON: Record<string, string> = { user: 'account', system: 'settings-gear' };
const SOURCE_TITLE: Record<string, string> = { user: 'User SSH config (~/.ssh/config)', system: 'System SSH config (read-only)' };
const SOURCE_ORDER: Record<string, number> = { user: 0, system: 1 };

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <Row gap={6} style={{ alignItems: 'baseline' }}>
            <Text muted size={11} style={{ width: 64, flexShrink: 0 }}>{label}</Text>
            <div style={{ minWidth: 0, fontSize: '12px', wordBreak: 'break-all' }}>{children}</div>
        </Row>
    );
}

function HostItem({ host }: { host: SshHost }) {
    const [open, setOpen] = useState(false);
    const src = host.source ?? 'system';
    return (
        <Stack>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Icon name={SOURCE_ICON[src] ?? 'remote'} title={SOURCE_TITLE[src]} />
                <Text weight={600} ellipsis>{host.name}</Text>
            </Row>
            {open ? (
                <Stack gap={4} pad="0 0 6px 22px">
                    <DetailRow label="Username">{host.user ?? '—'}</DetailRow>
                    <DetailRow label="Hostname">{host.hostname ?? '—'}</DetailRow>
                    {host.extraDirectives?.length ? (
                        <DetailRow label="Args"><Stack gap={1}>{host.extraDirectives.map(a => <div key={a}>{a}</div>)}</Stack></DetailRow>
                    ) : null}
                    {src === 'user' ? (
                        // zoom 0.85 matches the Sessions-view action buttons (e.g. Restart).
                        <Row justify="flex-end" pad="2px 0 0" style={{ zoom: 0.85 }}>
                            <Button icon="trash" onClick={() => post({ command: 'removeSshHost', name: host.name })}>Delete</Button>
                        </Row>
                    ) : null}
                </Stack>
            ) : null}
        </Stack>
    );
}

function HostList({ state }: { state: HostsState }) {
    const hosts = [...state.sshHosts].sort((a, b) => (SOURCE_ORDER[a.source ?? 'system'] ?? 9) - (SOURCE_ORDER[b.source ?? 'system'] ?? 9));
    if (hosts.length === 0) { return <Text muted style={{ margin: '4px 0' }}>No SSH hosts yet — use + above.</Text>; }
    return <>{hosts.map(host => <HostItem key={host.name} host={host} />)}</>;
}

function Root() {
    const state = useWebviewState<HostsState>();
    return state ? <Stack pad="4px 8px"><HostList state={state} /></Stack> : null;
}

render(<Root />, document.getElementById('root')!);

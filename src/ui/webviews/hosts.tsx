import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { HostsState, SshHost } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { Row, Stack, Text, Icon, Button, ActionIcon } from '@/ui/components/base';

const SOURCE_ICON: Record<string, string> = { user: 'account', system: 'settings-gear' };
const SOURCE_TITLE: Record<string, string> = { user: 'Managed by CyberShuttle', system: 'Not managed by CyberShuttle (read-only)' };
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
                    {/* zoom 0.85 matches the Sessions-view action buttons (e.g. Connect). */}
                    <Row gap={6} justify="flex-end" pad="2px 0 0" style={{ zoom: 0.85 }}>
                        {src === 'user' ? <Button icon="trash" onClick={() => post({ command: 'removeSshHost', name: host.name })}>Delete</Button> : null}
                    </Row>
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
    if (!state) { return null; }
    if (!state.account) { return <Stack pad="8px"><Button icon="account" onClick={() => post({ command: 'signIn' })}>Log in to CyberShuttle</Button></Stack>; }
    return (
        <Stack pad="4px 8px">
            <HostList state={state} />
            <Row gap={4} pad="8px 0 2px">
                <Text muted weight={600} size={11}>SSH KEYS</Text>
                <ActionIcon name="add" title="Add key" onClick={() => post({ command: 'addSshKey' })} />
            </Row>
            {state.sshKeys.map(key => (
                <Row key={key.name} gap={6} pad="2px 0 2px 22px">
                    <Text size={12} ellipsis>{key.name}</Text>
                    <Text muted size={11} ellipsis title={key.fingerprint}>{key.type}</Text>
                    <ActionIcon name="trash" title="Remove key" onClick={() => post({ command: 'removeSshKey', name: key.name })} />
                </Row>
            ))}
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

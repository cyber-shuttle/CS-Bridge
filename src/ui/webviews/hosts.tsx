import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { HostsState } from '@/models';
import type { SshHost, SshKey } from '@/control/types';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { Row, Stack, Text, Icon, Button, Chip, ActionIcon } from '@/ui/components/base';
import { SectionHeading, SignInPanel } from '@/ui/components/Control';

const address = (host: SshHost): string =>
    host.hostname ? `${host.user ? `${host.user}@` : ''}${host.hostname}${host.port && host.port !== 22 ? `:${host.port}` : ''}` : '—';

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <Row gap={6} style={{ alignItems: 'baseline' }}>
            <Text muted size={11} style={{ width: 64, flexShrink: 0 }}>{label}</Text>
            <div style={{ minWidth: 0, fontSize: '12px', wordBreak: 'break-all' }}>{children}</div>
        </Row>
    );
}

// Only `managed` entries were written by this API, so they are the only ones it may change.
function HostItem({ host }: { host: SshHost }) {
    const [open, setOpen] = useState(false);
    return (
        <Stack>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Icon name="vm" title={host.managed ? 'Managed by CyberShuttle' : 'Not managed by CyberShuttle'} />
                <Text weight={600} ellipsis>{host.name}</Text>
                <Text muted size={11} ellipsis>{address(host)}</Text>
            </Row>
            {open ? (
                <Stack gap={4} pad="0 0 6px 22px">
                    <DetailRow label="Key">{host.key ?? host.identityFile ?? '—'}</DetailRow>
                    {host.extraDirectives.length ? (
                        <DetailRow label="Options"><Stack gap={1}>{host.extraDirectives.map(d => <div key={d}>{d}</div>)}</Stack></DetailRow>
                    ) : null}
                    {/* zoom 0.85 matches the Sessions-view action buttons (e.g. Connect). */}
                    <Row gap={6} justify="flex-end" pad="2px 0 0" style={{ zoom: 0.85 }}>
                        <Button icon="plug" onClick={() => post({ command: 'testHost', name: host.name })}>Test</Button>
                        {host.managed ? <Button icon="edit" onClick={() => post({ command: 'editHost', name: host.name, key: host.key })}>Edit</Button> : null}
                        {host.managed ? <Button icon="trash" onClick={() => post({ command: 'deleteHost', name: host.name })}>Delete</Button> : null}
                    </Row>
                </Stack>
            ) : null}
        </Stack>
    );
}

function KeyItem({ sshKey }: { sshKey: SshKey }) {
    return (
        <Row gap={6} pad="2px 0 2px 22px">
            <Text size={12} ellipsis>{sshKey.name}</Text>
            <Chip label={sshKey.type} />
            <Text muted size={11} ellipsis style={{ minWidth: 0 }} title={sshKey.fingerprint}>{sshKey.fingerprint}</Text>
            <ActionIcon name="trash" title="Remove key" onClick={() => post({ command: 'deleteKey', name: sshKey.name })} />
        </Row>
    );
}

function Root() {
    const state = useWebviewState<HostsState>();
    if (!state) { return null; }
    if (!state.account) { return <SignInPanel note="Hosts and keys are managed by CyberShuttle." />; }
    return (
        <Stack gap={6} pad="4px 8px">
            <Row gap={6}>
                <Icon name="account" />
                <Text size={12} ellipsis>{state.account}</Text>
                <ActionIcon name="sign-out" title="Sign out" onClick={() => post({ command: 'signOut' })} />
            </Row>
            {state.error ? <Text size={12} color="var(--vscode-errorForeground)">{state.error}</Text> : null}
            <Stack>
                <SectionHeading label="SSH HOSTS" />
                {state.hosts.length
                    ? state.hosts.map(host => <HostItem key={host.name} host={host} />)
                    : <Text muted style={{ margin: '4px 0' }}>No hosts yet — use + above.</Text>}
            </Stack>
            <Stack>
                <SectionHeading label="SSH KEYS">
                    <ActionIcon name="add" title="Add key" onClick={() => post({ command: 'addKey' })} />
                </SectionHeading>
                {state.keys.length
                    ? state.keys.map(sshKey => <KeyItem key={sshKey.name} sshKey={sshKey} />)
                    : <Text muted style={{ margin: '4px 0' }}>No stored keys.</Text>}
            </Stack>
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

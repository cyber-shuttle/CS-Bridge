// Resources view. Inputs show pushed state; a draft exists only while a field is being edited.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { HostsState, SSHHost, SshKeyInfo } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { Row, Stack, Text, Icon, ActionIcon, Button, SingleSelect, Option } from '@/ui/components/base';

const KEY_STATUS_ICON: Record<SshKeyInfo['status'], string> = { 'private': 'key', 'public-only': 'lock', 'missing': 'warning' };
const KEY_STATUS_TITLE: Record<SshKeyInfo['status'], string> = {
    'private': 'Private key — assignable',
    'public-only': 'Public key only — the private half is not on this machine',
    'missing': 'Referenced by a host but not found on disk',
};

function Labeled({ label, children }: { label: string; children: ComponentChildren }) {
    return (
        <Row gap={6} style={{ alignItems: 'baseline' }}>
            <Text muted size={11} style={{ width: 72, flexShrink: 0 }}>{label}</Text>
            {children}
        </Row>
    );
}

function Field({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit: (v: string) => void }) {
    const [draft, setDraft] = useState<string | undefined>(undefined);
    return (
        <Labeled label={label}>
            <input
                value={draft ?? value}
                disabled={disabled}
                onInput={e => setDraft((e.target as HTMLInputElement).value)}
                onBlur={() => { if (draft !== undefined && draft !== value) { onCommit(draft); } setDraft(undefined); }}
                style={{
                    flex: 1, minWidth: 0, font: 'inherit', fontSize: '12px',
                    background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border, transparent)', borderRadius: '2px', padding: '2px 4px',
                }}
            />
        </Labeled>
    );
}

function IdentityFiles({ host, keys, disabled }: { host: SSHHost; keys: SshKeyInfo[]; disabled: boolean }) {
    const files = host.Config.identityfile ?? [];
    const assignable = keys.filter(k => k.status === 'private' && !k.hosts.includes(host.Name));
    return (
        <Stack gap={2}>
            <Text muted size={11}>Identity Files</Text>
            {files.map(f => (
                <Row key={f} gap={4} justify="space-between">
                    <Text size={12} ellipsis>{f}</Text>
                    {disabled ? null : <ActionIcon name="close" title="Remove" onClick={() => post({ command: 'removeIdentityFile', name: host.Name, identityFile: f })} />}
                </Row>
            ))}
            {!disabled && assignable.length
                ? (
                        <SingleSelect
                            value=""
                            style={{ width: '100%', maxWidth: 'none' }}
                            onChange={(v) => { if (v) { post({ command: 'addIdentityFile', name: host.Name, identityFile: v }); } }}
                        >
                            <Option value="">+ Add key…</Option>
                            {assignable.map(k => <Option key={k.path} value={k.path}>{k.path}</Option>)}
                        </SingleSelect>
                    )
                : null}
        </Stack>
    );
}

function HostItem({ host, keys, converted }: { host: SSHHost; keys: SshKeyInfo[]; converted: boolean }) {
    const [open, setOpen] = useState(false);
    const edit = (key: string) => (value: string) => post({ command: 'editHostField', name: host.Name, field: key, value });
    const field = (key: string, label: string) => <Field label={label} value={host.Config[key]?.[0] ?? ''} disabled={!converted} onCommit={edit(key)} />;
    return (
        <Stack>
            <Row gap={4} pad="3px 0" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <Icon name="remote" />
                <Text weight={600} ellipsis>{host.Name}</Text>
            </Row>
            {open ? (
                <Stack gap={4} pad="0 0 8px 22px">
                    <Field label="Host" value={host.Name} disabled={!converted} onCommit={v => v && post({ command: 'renameHost', name: host.Name, value: v })} />
                    {field('hostname', 'HostName')}
                    {field('user', 'User')}
                    {field('port', 'Port')}
                    {field('proxyjump', 'ProxyJump')}
                    <Labeled label="ForwardAgent">
                        <SingleSelect value={host.Config.forwardagent?.[0] ?? 'no'} disabled={!converted} style={{ flex: 1, maxWidth: 'none' }} onChange={edit('forwardagent')}>
                            <Option value="no">no</Option>
                            <Option value="yes">yes</Option>
                        </SingleSelect>
                    </Labeled>
                    <IdentityFiles host={host} keys={keys} disabled={!converted} />
                    <Row gap={6} justify="flex-end" pad="2px 0 0" style={{ zoom: 0.85 }}>
                        <Button icon="terminal" onClick={() => post({ command: 'openTerminal', name: host.Name })}>Terminal</Button>
                        <Button icon="trash" onClick={() => post({ command: 'removeSshHost', name: host.Name })}>Delete</Button>
                    </Row>
                </Stack>
            ) : null}
        </Stack>
    );
}

function KeyItem({ info }: { info: SshKeyInfo }) {
    return (
        <Row gap={6} pad="2px 0">
            <Icon name={KEY_STATUS_ICON[info.status]} title={`${KEY_STATUS_TITLE[info.status]}${info.fingerprint ? ` (${info.fingerprint})` : ''}`} />
            <Text size={12} ellipsis style={{ flex: 1 }}>{info.path}</Text>
            {info.hosts.length ? <Text muted size={11} ellipsis style={{ maxWidth: '40%' }}>{info.hosts.join(', ')}</Text> : null}
        </Row>
    );
}

function ConvertPrompt() {
    return (
        <Stack gap={6} pad="4px 0 8px">
            <Text muted size={12}>
                ~/.ssh/config hasn't been converted for CS Bridge yet. Converting rewrites it into a flattened, editable
                form and keeps the original at ~/.ssh/config.csbridge-backup. Hosts below are read-only until then.
            </Text>
            <Button onClick={() => post({ command: 'convert' })}>Convert ~/.ssh/config</Button>
        </Stack>
    );
}

function Section({ title, empty, children }: { title: string; empty: string; children: ComponentChildren[] }) {
    return (
        <Stack gap={2}>
            <Text weight={600} size={11}>{title}</Text>
            {children.length ? children : <Text muted style={{ margin: '4px 0' }}>{empty}</Text>}
        </Stack>
    );
}

function Root() {
    const state = useWebviewState<HostsState>();
    if (!state) { return null; }
    const hosts = [...state.sshHosts].sort((a, b) => a.Name.localeCompare(b.Name));
    return (
        <Stack pad="4px 8px" gap={10}>
            {!state.converted ? <ConvertPrompt /> : null}
            <Section title="SSH Hosts" empty="No SSH hosts yet — use + above.">
                {hosts.map(host => <HostItem key={host.Name} host={host} keys={state.sshKeys} converted={state.converted} />)}
            </Section>
            <Section title="SSH Keys" empty="No SSH keys found.">
                {state.sshKeys.map(k => <KeyItem key={k.path} info={k} />)}
            </Section>
        </Stack>
    );
}

render(<Root />, document.getElementById('root')!);

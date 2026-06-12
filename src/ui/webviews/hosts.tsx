import { render } from 'preact';
import type { HostsState } from '@/models';
import { post, useWebviewState } from '@/ui/platform/vscode';
import { Row, Stack, Text, Icon, ActionIcon } from '@/ui/components/base';

const SOURCE_ICON: Record<string, string> = { managed: 'cloud', user: 'account', system: 'settings-gear' };
const SOURCE_TITLE: Record<string, string> = { managed: 'Managed by CS Bridge', user: 'User SSH config', system: 'System SSH config (read-only)' };
const SOURCE_ORDER: Record<string, number> = { managed: 0, user: 1, system: 2 };

function HostList({ state }: { state: HostsState }) {
    const hosts = [...state.sshHosts].sort((a, b) => (SOURCE_ORDER[a.source ?? 'system'] ?? 9) - (SOURCE_ORDER[b.source ?? 'system'] ?? 9));
    if (hosts.length === 0) { return <Text muted style={{ margin: '4px 0' }}>No SSH hosts yet — use + above.</Text>; }
    return (
        <>
            {hosts.map(host => {
                const detail = host.hostname ? `${host.user ? host.user + '@' : ''}${host.hostname}` : undefined;
                const canDelete = host.source === 'managed' || host.source === 'user';
                const src = host.source ?? 'system';
                return (
                    <Row key={host.name} gap={6} pad="2px 0">
                        <Icon name={SOURCE_ICON[src] ?? 'remote'} title={SOURCE_TITLE[src]} />
                        <Text weight={600} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{host.name}</Text>
                        {detail ? <Text muted size={11} ellipsis style={{ minWidth: 0 }}>{detail}</Text> : null}
                        {canDelete ? <ActionIcon name="trash" title="Remove SSH host" onClick={() => post({ command: 'removeSshHost', name: host.name, source: host.source })} /> : null}
                    </Row>
                );
            })}
        </>
    );
}

function Root() {
    const state = useWebviewState<HostsState>();
    return state ? <Stack pad="4px 8px"><HostList state={state} /></Stack> : null;
}

render(<Root />, document.getElementById('root')!);

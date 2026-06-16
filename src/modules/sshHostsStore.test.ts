import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseHostsFromConfigText,
    addHostToConfigText,
    removeHostFromConfigText,
    mergeHostsByPriority,
    buildSessionSshConfigBlock,
    SSH_RESILIENCE_OPTIONS,
} from './sshHostsStore';

test('parseHostsFromConfigText reads Host/HostName/User and skips wildcards', () => {
    const text = 'Host work\n  HostName work.example.com\n  User alice\n\nHost *\n  ServerAliveInterval 60\n';
    assert.deepEqual(parseHostsFromConfigText(text), [{ name: 'work', hostname: 'work.example.com', user: 'alice' }]);
});

test('parseHostsFromConfigText captures extra directives as args', () => {
    const text = 'Host gpu\n  HostName gpu.example.com\n  User bob\n  Port 2222\n  ForwardAgent yes\n';
    assert.deepEqual(parseHostsFromConfigText(text), [
        { name: 'gpu', hostname: 'gpu.example.com', user: 'bob', args: ['Port 2222', 'ForwardAgent yes'] },
    ]);
});

test('parseHostsFromConfigText flattens multi-token directives instead of emitting [object Object]', () => {
    const text = 'Host bastioned\n  HostName internal.example.com\n  User carol\n  ProxyCommand ssh -W %h:%p bastion\n  SendEnv LANG LC_*\n';
    assert.deepEqual(parseHostsFromConfigText(text), [
        { name: 'bastioned', hostname: 'internal.example.com', user: 'carol', args: ['ProxyCommand ssh -W %h:%p bastion', 'SendEnv LANG LC_*'] },
    ]);
});

test('addHostToConfigText adds an entry that round-trips', () => {
    const text = addHostToConfigText('', { Host: 'h', HostName: 'h', User: 'a' });
    assert.deepEqual(parseHostsFromConfigText(text), [{ name: 'h', hostname: 'h', user: 'a' }]);
});

test('addHostToConfigText replaces an existing alias instead of duplicating', () => {
    const t1 = addHostToConfigText('', { Host: 'h', HostName: 'h1', User: 'a' });
    const t2 = addHostToConfigText(t1, { Host: 'h', HostName: 'h2', User: 'b' });
    assert.deepEqual(parseHostsFromConfigText(t2), [{ name: 'h', hostname: 'h2', user: 'b' }]);
});

test('addHostToConfigText prepends newest above existing', () => {
    const base = addHostToConfigText('', { Host: 'first', HostName: 'f' });
    const both = addHostToConfigText(base, { Host: 'second', HostName: 's' });
    assert.deepEqual(parseHostsFromConfigText(both).map(h => h.name), ['second', 'first']);
});

test('removeHostFromConfigText removes the named entry', () => {
    const text = addHostToConfigText('', { Host: 'h', HostName: 'h' });
    assert.deepEqual(parseHostsFromConfigText(removeHostFromConfigText(text, 'h')), []);
});

test('buildSessionSshConfigBlock emits the six SSH resilience options', () => {
    const block = buildSessionSshConfigBlock('sess1', 'cshost-sess1', '127.0.0.1', 50122, 'cs-ssh-user', '/keys/id_cshost-sess1');
    assert.equal(SSH_RESILIENCE_OPTIONS.length, 6);
    for (const [key, value] of SSH_RESILIENCE_OPTIONS) {
        assert.match(block, new RegExp(`^    ${key} ${value}$`, 'm'));
    }
    assert.match(block, /^# CS-Bridge auto-generated for session sess1$/m);
    assert.match(block, /^Host cshost-sess1$/m);
    assert.match(block, /^    Port 50122$/m);
    assert.match(block, /^    IdentityFile \/keys\/id_cshost-sess1$/m);
});

// removeSSHConfigEntry's removal regex only matches 4-space-indented directive lines.
test('buildSessionSshConfigBlock indents every directive so removeSSHConfigEntry can remove it', () => {
    const block = buildSessionSshConfigBlock('s', 'cshost-s', '127.0.0.1', 22, 'u', '/k');
    for (const line of block.split('\n')) {
        if (line === '' || line.startsWith('#') || line.startsWith('Host ')) { continue; }
        assert.match(line, /^ {4}\S/);
    }
});

test('mergeHostsByPriority keeps the first occurrence of each name (user wins over system)', () => {
    const user = [{ name: 'a', source: 'user' as const }, { name: 'b', hostname: 'user-b', source: 'user' as const }];
    const system = [{ name: 'b', hostname: 'system-b', source: 'system' as const }, { name: 'c', source: 'system' as const }];
    const merged = mergeHostsByPriority(user, system);
    assert.deepEqual(merged.map(h => h.name), ['a', 'b', 'c']);
    assert.equal(merged.find(h => h.name === 'b')?.hostname, 'user-b');
    assert.equal(merged.find(h => h.name === 'b')?.source, 'user');
});

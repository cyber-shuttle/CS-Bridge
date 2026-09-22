import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    includeIsEffective,
    parseHostsFromConfigText,
    mergeHostsByPriority,
    buildSshConfigBlock,
    csHostAlias,
    SSH_RESILIENCE_OPTIONS,
} from './sshHostsStore';

test('csHostAlias is <cluster>-<last 6 chars of the session name>', () => {
    assert.equal(csHostAlias('delta', '1782444493119'), 'delta-493119');
    assert.equal(csHostAlias('delta', 'abc'), 'delta-abc'); // shorter than 6: whole name
});

test('parseHostsFromConfigText reads Host/HostName/User and skips wildcards', () => {
    const text = 'Host work\n  HostName work.example.com\n  User alice\n\nHost *\n  ServerAliveInterval 60\n';
    assert.deepEqual(parseHostsFromConfigText(text), [{ name: 'work', hostname: 'work.example.com', user: 'alice' }]);
});

test('parseHostsFromConfigText captures extra directives', () => {
    const text = 'Host gpu\n  HostName gpu.example.com\n  User bob\n  Port 2222\n  ForwardAgent yes\n';
    assert.deepEqual(parseHostsFromConfigText(text), [
        { name: 'gpu', hostname: 'gpu.example.com', user: 'bob', extraDirectives: ['Port 2222', 'ForwardAgent yes'] },
    ]);
});

test('parseHostsFromConfigText flattens multi-token directives instead of emitting [object Object]', () => {
    const text = 'Host bastioned\n  HostName internal.example.com\n  User carol\n  ProxyCommand ssh -W %h:%p bastion\n  SendEnv LANG LC_*\n';
    assert.deepEqual(parseHostsFromConfigText(text), [
        { name: 'bastioned', hostname: 'internal.example.com', user: 'carol', extraDirectives: ['ProxyCommand ssh -W %h:%p bastion', 'SendEnv LANG LC_*'] },
    ]);
});

test('buildSshConfigBlock emits the six SSH resilience options', () => {
    const block = buildSshConfigBlock('sess1', csHostAlias('delta', 'sess1-493119'), '127.0.0.1', 50122, 'cs-ssh-user', '/keys/id_cshost-sess1');
    assert.equal(SSH_RESILIENCE_OPTIONS.length, 6);
    for (const [key, value] of SSH_RESILIENCE_OPTIONS) {
        assert.match(block, new RegExp(`^    ${key} ${value}$`, 'm'));
    }
    assert.match(block, /^# CS-Bridge auto-generated for session sess1$/m);
    assert.match(block, /^Host delta-493119$/m);
    assert.match(block, /^ {4}Port 50122$/m);
    assert.match(block, /^ {4}IdentityFile \/keys\/id_cshost-sess1$/m);
});

// removeSshConfigEntry's removal regex only matches 4-space-indented directive lines.
test('buildSshConfigBlock indents every directive so removeSshConfigEntry can remove it', () => {
    const block = buildSshConfigBlock('s', csHostAlias('delta', 'abc123'), '127.0.0.1', 22, 'u', '/k');
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

test('includeIsEffective accepts only an uncommented Include above the first Host/Match block', () => {
    const line = 'Include ~/.cybershuttle/ssh_config';
    assert.equal(includeIsEffective('', line), false);
    assert.equal(includeIsEffective(`${line}\nHost foo\n    HostName x\n`, line), true);
    assert.equal(includeIsEffective(`  ${line}  \n`, line), true, 'surrounding whitespace is not significant');
    assert.equal(includeIsEffective(`# ${line}\n`, line), false, 'a commented Include does nothing');
    assert.equal(includeIsEffective(`Host *\n    ${line}\n`, line), false, 'scoped to a Host block, not global');
    assert.equal(includeIsEffective(`Match host bar\n    ${line}\n`, line), false, 'scoped to a Match block');
});

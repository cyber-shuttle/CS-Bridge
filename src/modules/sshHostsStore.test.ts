import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseHostsFromConfigText,
    addHostToConfigText,
    removeHostFromConfigText,
    mergeHostsManagedWins,
} from './sshHostsStore';

test('parseHostsFromConfigText reads Host/HostName/User and skips wildcards', () => {
    const text = 'Host work\n  HostName work.example.com\n  User alice\n\nHost *\n  ServerAliveInterval 60\n';
    assert.deepEqual(parseHostsFromConfigText(text), [{ name: 'work', hostname: 'work.example.com', user: 'alice' }]);
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

test('mergeHostsManagedWins puts managed first and overrides clashes', () => {
    const global = [{ name: 'a', managed: false }, { name: 'b', hostname: 'global-b', managed: false }];
    const managed = [{ name: 'b', hostname: 'managed-b', managed: true }];
    const merged = mergeHostsManagedWins(global, managed);
    assert.deepEqual(merged.map(h => h.name), ['b', 'a']);
    assert.equal(merged.find(h => h.name === 'b')?.hostname, 'managed-b');
});

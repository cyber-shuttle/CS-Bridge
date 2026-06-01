import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshCommandToConfig, assertValidHost, CommandParseError } from './sshCommandParser';

test('bare host', () => {
    assert.deepEqual(sshCommandToConfig('ssh example.com'), { Host: 'example.com', HostName: 'example.com' });
});

test('user@host', () => {
    assert.deepEqual(sshCommandToConfig('ssh alice@example.com'), { Host: 'example.com', HostName: 'example.com', User: 'alice' });
});

test('-p port', () => {
    assert.deepEqual(sshCommandToConfig('ssh alice@example.com -p 2222'), { Host: 'example.com', HostName: 'example.com', User: 'alice', Port: '2222' });
});

test('-i identity file before host', () => {
    assert.deepEqual(sshCommandToConfig('ssh -i ~/.ssh/key alice@h'), { Host: 'h', HostName: 'h', User: 'alice', IdentityFile: '~/.ssh/key' });
});

test('-A forward agent after host', () => {
    assert.deepEqual(sshCommandToConfig('ssh hello@microsoft.com -A'), { Host: 'microsoft.com', HostName: 'microsoft.com', User: 'hello', ForwardAgent: 'yes' });
});

test('-J proxy jump', () => {
    assert.deepEqual(sshCommandToConfig('ssh -J bastion alice@h'), { Host: 'h', HostName: 'h', User: 'alice', ProxyJump: 'bastion' });
});

test('-L local forward', () => {
    assert.deepEqual(sshCommandToConfig('ssh -L 8080:localhost:80 alice@h'), { Host: 'h', HostName: 'h', User: 'alice', LocalForward: '8080 localhost:80' });
});

test('-o passthrough', () => {
    assert.deepEqual(sshCommandToConfig('ssh -o ServerAliveInterval=60 h'), { Host: 'h', HostName: 'h', ServerAliveInterval: '60' });
});

test('ssh:// url with port', () => {
    assert.deepEqual(sshCommandToConfig('ssh ssh://alice@h:2222'), { Host: 'h', HostName: 'h', User: 'alice', Port: '2222' });
});

test('user@host:port shorthand', () => {
    assert.deepEqual(sshCommandToConfig('ssh alice@h:2200'), { Host: 'h', HostName: 'h', User: 'alice', Port: '2200' });
});

test('missing host throws', () => {
    assert.throws(() => sshCommandToConfig('ssh -A'), CommandParseError);
});

test('unknown flag throws', () => {
    assert.throws(() => sshCommandToConfig('ssh -Z h'), CommandParseError);
});

test('flag missing required argument throws', () => {
    assert.throws(() => sshCommandToConfig('ssh -p'), CommandParseError);
});

test('assertValidHost passes a clean host', () => {
    assert.doesNotThrow(() => assertValidHost({ Host: 'h', HostName: 'h', User: 'alice' }));
});

test('assertValidHost rejects leading dash', () => {
    assert.throws(() => assertValidHost({ Host: '-h', HostName: '-h' }), CommandParseError);
});

test('assertValidHost rejects backtick', () => {
    assert.throws(() => assertValidHost({ Host: 'h', HostName: 'h`x' }), CommandParseError);
});

test('assertValidHost rejects User starting with dash', () => {
    assert.throws(() => assertValidHost({ Host: 'h', HostName: 'h', User: '-bad' }), CommandParseError);
});

test('assertValidHost rejects backtick in User', () => {
    assert.throws(() => assertValidHost({ Host: 'h', HostName: 'h', User: 'a`id`' }), CommandParseError);
});

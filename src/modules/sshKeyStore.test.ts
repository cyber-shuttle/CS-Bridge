import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SSHHost } from '../models';
import { CommandRunner } from './commandRunner';
import { discoverKeys } from './sshKeyStore';

function tmpSshDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'csbridge-keys-test-'));
}

// ssh-keygen -l -f succeeds only for paths in `known`, with the given fingerprint.
function fakeKeygenRunner(known: Record<string, string>): CommandRunner {
    return (cmd, args) => {
        if (cmd !== 'ssh-keygen') { return { stdout: '', status: 1 }; }
        const fp = known[args[args.length - 1]];
        return fp === undefined ? { stdout: '', status: 1 } : { stdout: `256 ${fp} comment (ED25519)\n`, status: 0 };
    };
}

test('discoverKeys marks a referenced key with a private file present as private and assignable', () => {
    const dir = tmpSshDir();
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyPath, 'private key bytes');
    const runner = fakeKeygenRunner({ [keyPath]: 'SHA256:aaaa' });
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { identityfile: [keyPath] } }];

    const keys = discoverKeys(hosts, runner, dir);
    assert.deepEqual(keys, [{ path: keyPath, fingerprint: 'SHA256:aaaa', status: 'private', hosts: ['delta'] }]);
});

test('discoverKeys marks a key with only a .pub file as public-only and not assignable', () => {
    const dir = tmpSshDir();
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA...');
    const runner = fakeKeygenRunner({ [`${keyPath}.pub`]: 'SHA256:bbbb' });
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { identityfile: [keyPath] } }];

    const keys = discoverKeys(hosts, runner, dir);
    assert.deepEqual(keys, [{ path: keyPath, fingerprint: 'SHA256:bbbb', status: 'public-only', hosts: ['delta'] }]);
});

test('discoverKeys marks a referenced key with neither file present as missing', () => {
    const dir = tmpSshDir();
    const keyPath = path.join(dir, 'id_missing');
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { identityfile: [keyPath] } }];

    const keys = discoverKeys(hosts, fakeKeygenRunner({}), dir);
    assert.deepEqual(keys, [{ path: keyPath, fingerprint: '', status: 'missing', hosts: ['delta'] }]);
});

test('discoverKeys excludes generated CS Bridge keys, by directory and by id_cshost- name', () => {
    const dir = tmpSshDir();
    const csKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csbridge-genkeys-'));
    const generatedUnderCsDir = path.join(csKeysDir, 'id_cshost-abc');
    fs.writeFileSync(generatedUnderCsDir, 'private');
    const generatedByName = path.join(dir, 'id_cshost-xyz');
    fs.writeFileSync(generatedByName, 'private');
    const runner = fakeKeygenRunner({ [generatedUnderCsDir]: 'SHA256:cccc', [generatedByName]: 'SHA256:dddd' });
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { identityfile: [generatedUnderCsDir, generatedByName] } }];

    assert.deepEqual(discoverKeys(hosts, runner, dir), []);
});

test('discoverKeys finds a recognizable key in ~/.ssh that no host references', () => {
    const dir = tmpSshDir();
    const keyPath = path.join(dir, 'id_ecdsa');
    fs.writeFileSync(keyPath, 'private key bytes');
    const runner = fakeKeygenRunner({ [keyPath]: 'SHA256:eeee' });

    const keys = discoverKeys([], runner, dir);
    assert.deepEqual(keys, [{ path: keyPath, fingerprint: 'SHA256:eeee', status: 'private', hosts: [] }]);
});

test('discoverKeys skips a ~/.ssh file ssh-keygen does not recognize as a key (e.g. known_hosts)', () => {
    const dir = tmpSshDir();
    fs.writeFileSync(path.join(dir, 'known_hosts'), 'example.com ssh-ed25519 AAAA...');
    fs.writeFileSync(path.join(dir, 'config'), 'Host x\n');

    assert.deepEqual(discoverKeys([], fakeKeygenRunner({}), dir), []);
});

test('discoverKeys treats a .pub sibling as evidence of the same key, not a second one', () => {
    const dir = tmpSshDir();
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyPath, 'private key bytes');
    fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA...');
    const runner = fakeKeygenRunner({ [keyPath]: 'SHA256:ffff' });

    const keys = discoverKeys([], runner, dir);
    assert.deepEqual(keys.length, 1);
    assert.equal(keys[0].status, 'private');
});

test('discoverKeys collects every host that references the same key', () => {
    const dir = tmpSshDir();
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyPath, 'private key bytes');
    const runner = fakeKeygenRunner({ [keyPath]: 'SHA256:gggg' });
    const hosts: SSHHost[] = [
        { Name: 'delta', Config: { identityfile: [keyPath] } },
        { Name: 'expanse', Config: { identityfile: [keyPath] } },
    ];

    const keys = discoverKeys(hosts, runner, dir);
    assert.deepEqual(keys[0].hosts.sort(), ['delta', 'expanse']);
});

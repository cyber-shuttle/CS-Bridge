import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { SSHHost } from '../models';
import { CommandRunner, CommandResult, systemRunner } from './commandRunner';
import {
    includeIsEffective,
    buildSshConfigBlock,
    csHostAlias,
    SSH_RESILIENCE_OPTIONS,
    collectAliases,
    importHosts,
    parseSshGOutput,
    renderHostStanza,
    renderCanonicalConfig,
    isConverted,
    convertToCanonical,
    validateAndCommit,
    CS_SSH_CONFIG_PATH,
} from './sshHostsStore';

// -------------------------------------------------------------------------------------------------
// Test doubles
// -------------------------------------------------------------------------------------------------

const importedAliasesOf = (cfg: string, dir: string) => [...new Set(collectAliases(cfg, new Set(), dir))];

// Maps `ssh -G -F <config> <alias>` to canned output, keyed by "<config>::<alias>". Records every invocation.
function fakeSshRunner(responses: Record<string, string>): CommandRunner & { calls: string[][] } {
    const calls: string[][] = [];
    return Object.assign((cmd: string, args: string[]): CommandResult => {
        calls.push([cmd, ...args]);
        if (cmd !== 'ssh') { return { stdout: '', status: 1 }; }
        const [, , configPath, alias] = args; // ['-G', '-F', configPath, alias]
        const stdout = responses[`${configPath}::${alias}`];
        return stdout === undefined ? { stdout: '', status: 255 } : { stdout, status: 0 };
    }, { calls });
}

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'csbridge-ssh-test-'));
}

function write(dir: string, name: string, contents: string): string {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    return full;
}

// -------------------------------------------------------------------------------------------------
// csHostAlias / buildSshConfigBlock / includeIsEffective — unchanged behaviour
// -------------------------------------------------------------------------------------------------

// removeSshConfigEntry's removal regex only matches 4-space-indented directive lines.
test('buildSshConfigBlock indents every directive so removeSshConfigEntry can remove it', () => {
    const block = buildSshConfigBlock('s', csHostAlias('delta', 'abc123'), '127.0.0.1', 22, 'u', '/k');
    for (const line of block.split('\n')) {
        if (line === '' || line.startsWith('#') || line.startsWith('Host ')) { continue; }
        assert.match(line, /^ {4}\S/);
    }
});

test('csHostAlias is <cluster>-<last 6 chars of the session name>', () => {
    assert.equal(csHostAlias('delta', '1782444493119'), 'delta-493119');
    assert.equal(csHostAlias('delta', 'abc'), 'delta-abc'); // shorter than 6: whole name
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

test('includeIsEffective accepts only an uncommented Include above the first Host/Match block', () => {
    const line = 'Include ~/.cybershuttle/ssh_config';
    assert.equal(includeIsEffective('', line), false);
    assert.equal(includeIsEffective(`${line}\nHost foo\n    HostName x\n`, line), true);
    assert.equal(includeIsEffective(`  ${line}  \n`, line), true, 'surrounding whitespace is not significant');
    assert.equal(includeIsEffective(`# ${line}\n`, line), false, 'a commented Include does nothing');
    assert.equal(includeIsEffective(`Host *\n    ${line}\n`, line), false, 'scoped to a Host block, not global');
    assert.equal(includeIsEffective(`Match host bar\n    ${line}\n`, line), false, 'scoped to a Match block');
});

// -------------------------------------------------------------------------------------------------
// collectAliases: Host-line filtering, multi-pattern lines, Include traversal
// -------------------------------------------------------------------------------------------------

test('collectAliases keeps concrete aliases and drops wildcard and negated patterns', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', 'Host foo bar !baz web*\n  HostName x\n\nHost single\n  HostName y\n\nHost ?wild\n  HostName z\n');
    assert.deepEqual(collectAliases(cfg, new Set(), dir), ['foo', 'bar', 'single']);
});

test('collectAliases follows Include, recursively, resolving a relative pattern against baseDir', () => {
    const dir = tmpDir();
    write(dir, 'conf.d/inner.conf', 'Host inner\n  HostName inner.example.com\n');
    const cfg = write(dir, 'config', 'Include conf.d/inner.conf\n\nHost outer\n  HostName x\n');
    assert.deepEqual(importedAliasesOf(cfg, dir), ['inner', 'outer']);
});

test('collectAliases expands a glob Include pattern in sorted order', () => {
    const dir = tmpDir();
    write(dir, 'conf.d/b.conf', 'Host b\n  HostName b\n');
    write(dir, 'conf.d/a.conf', 'Host a\n  HostName a\n');
    const cfg = write(dir, 'config', 'Include conf.d/*.conf\n');
    assert.deepEqual(importedAliasesOf(cfg, dir), ['a', 'b']);
});

test('collectAliases excludes ~/.cybershuttle/ssh_config from traversal', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost real\n  HostName x\n`);
    assert.deepEqual(collectAliases(cfg, new Set(), dir), ['real']);
});

test('collectAliases dedupes Include cycles instead of recursing forever', () => {
    const dir = tmpDir();
    const a = path.join(dir, 'a.conf');
    const b = path.join(dir, 'b.conf');
    fs.writeFileSync(a, `Include ${b}\nHost a\n  HostName a\n`);
    fs.writeFileSync(b, `Include ${a}\nHost b\n  HostName b\n`);
    assert.deepEqual(importedAliasesOf(a, dir), ['b', 'a']);
});

// -------------------------------------------------------------------------------------------------
// parseSshGOutput / importHosts
// -------------------------------------------------------------------------------------------------

test('parseSshGOutput groups a repeated key into an array in printed order and drops the host line', () => {
    const stdout = 'host delta\nuser alice\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/sg_delta\nproxyjump bastion\n';
    assert.deepEqual(parseSshGOutput(stdout), {
        user: ['alice'],
        identityfile: ['~/.ssh/id_ed25519', '~/.ssh/sg_delta'],
        proxyjump: ['bastion'],
    });
});

test('parseSshGOutput keeps a value with embedded spaces verbatim', () => {
    assert.deepEqual(parseSshGOutput('host x\nproxycommand ssh -q sg-prod nc %h %p\n'), {
        proxycommand: ['ssh -q sg-prod nc %h %p'],
    });
});

test('importHosts resolves every imported alias and skips one ssh -G refuses', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', 'Host good bad\n  HostName x\n');
    const runner = fakeSshRunner({ [`${cfg}::good`]: 'host good\nuser alice\n' }); // 'bad' has no canned response
    assert.deepEqual(importHosts(runner, cfg, dir), [{ Name: 'good', Config: { user: ['alice'] } }]);
});

// -------------------------------------------------------------------------------------------------
// Canonical rendering + the shared Go/TypeScript contract fixture
// -------------------------------------------------------------------------------------------------

const CONTRACT_FIXTURE_PATH = path.join(__dirname, 'testdata', 'ssh-host-contract.json');

test('renderHostStanza sorts keys in plain codepoint order and prints one line per value', () => {
    const host: SSHHost = { Name: 'delta', Config: { user: ['alice'], identityfile: ['a', 'b'], hostname: ['h'] } };
    assert.equal(renderHostStanza(host), 'Host delta\n    hostname h\n    identityfile a\n    identityfile b\n    user alice');
});

test('renderCanonicalConfig starts with the CS Bridge Include line, the marker, then a blank-line-separated stanza per host', () => {
    const hosts: SSHHost[] = [{ Name: 'a', Config: { user: ['x'] } }, { Name: 'b', Config: { user: ['y'] } }];
    const text = renderCanonicalConfig(hosts);
    assert.match(text, new RegExp(`^Include ${CS_SSH_CONFIG_PATH.replace(/[.\\/]/g, '\\$&')}\n# Managed by CS Bridge`));
    assert.ok(text.endsWith('\n\nHost a\n    user x\n\nHost b\n    user y\n'));
});

test('renderCanonicalConfig is deterministic for the same input', () => {
    const hosts: SSHHost[] = [{ Name: 'a', Config: { user: ['x'], port: ['22'] } }];
    assert.equal(renderCanonicalConfig(hosts), renderCanonicalConfig(hosts));
});

test('the contract fixture renders the shared stanza and survives a JSON round-trip', () => {
    const fixture = JSON.parse(fs.readFileSync(CONTRACT_FIXTURE_PATH, 'utf-8')) as SSHHost;
    assert.equal(renderHostStanza(fixture), [
        'Host delta',
        '    forwardagent yes',
        '    hostname login.delta.example.edu',
        '    identityfile ~/.ssh/id_ed25519',
        '    identityfile ~/.ssh/sg_delta',
        '    port 22',
        '    proxyjump bastion',
        '    user alice',
    ].join('\n'));
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture);
});
// -------------------------------------------------------------------------------------------------
// Conversion: verified round-trip, one-time backup, atomic write
// -------------------------------------------------------------------------------------------------

test('convertToCanonical backs up the original and rewrites the config to the canonical form', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', 'Host delta\n  HostName login.delta.example.edu\n  User alice\n');
    const backup = `${cfg}.csbridge-backup`;
    // A stable runner: every ssh -G call for `delta`, against any config path, resolves the same way — so the
    // pre-write check and the verification-temp-file check necessarily agree.
    const runner: CommandRunner = () => ({ stdout: 'host delta\nhostname login.delta.example.edu\nuser alice\n', status: 0 });
    const hosts = convertToCanonical(runner, cfg, backup);

    assert.deepEqual(hosts.map(h => h.Name), ['delta']);
    assert.ok(fs.existsSync(backup), 'backup written');
    assert.equal(fs.readFileSync(backup, 'utf-8'), 'Host delta\n  HostName login.delta.example.edu\n  User alice\n');
    const rewritten = fs.readFileSync(cfg, 'utf-8');
    assert.ok(rewritten.startsWith(`Include ${CS_SSH_CONFIG_PATH}`));
    assert.match(rewritten, /^Host delta$/m);
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    assert.ok(isConverted(cfg));
});

test('convertToCanonical never overwrites an existing backup', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', 'Host delta\n  HostName x\n');
    const backup = write(dir, 'config.csbridge-backup', 'original content, must survive');
    const runner: CommandRunner = () => ({ stdout: 'host delta\nhostname x\n', status: 0 });
    convertToCanonical(runner, cfg, backup);
    assert.equal(fs.readFileSync(backup, 'utf-8'), 'original content, must survive');
});

test('convertToCanonical aborts, naming the alias, and writes nothing when a host resolves differently', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', 'Host delta\n  HostName x\n');
    const backup = `${cfg}.csbridge-backup`;
    // The real config (cfg) resolves 'delta' one way; any other config path (the verification temp file)
    // resolves it differently, simulating a host whose meaning would change under the canonical rendering.
    const runner: CommandRunner = (_cmd, args) => ({ stdout: args[2] === cfg ? 'host delta\nhostname x\n' : 'host delta\nhostname mismatched\n', status: 0 });
    assert.throws(() => convertToCanonical(runner, cfg, backup), /'delta' would resolve differently/);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), 'Host delta\n  HostName x\n', 'the real file is untouched');
    assert.ok(!fs.existsSync(backup), 'no backup on a failed conversion');
});

// -------------------------------------------------------------------------------------------------
// Post-conversion mutation: validateAndCommit
// -------------------------------------------------------------------------------------------------

test('validateAndCommit rejects an invalid Port and leaves the real file untouched', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost delta\n    hostname x\n    port 22\n`);
    const before = fs.readFileSync(cfg, 'utf-8');
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { hostname: ['x'], port: ['not-a-port'] } }];
    assert.throws(() => validateAndCommit(systemRunner, () => ({ hosts, edited: 'delta' }), cfg), Error);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), before);
});

test('validateAndCommit rejects a directive that does not round-trip for the edited host', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost delta\n    hostname x\n`);
    const before = fs.readFileSync(cfg, 'utf-8');
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { hostname: ['x'], nosuchdirective: ['y'] } }];
    const runner: CommandRunner = () => ({ stdout: 'host delta\nhostname x\n', status: 0 }); // silently drops nosuchdirective
    assert.throws(() => validateAndCommit(runner, () => ({ hosts, edited: 'delta' }), cfg), Error);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), before);
});

test('validateAndCommit rejects a wildcard or duplicate alias before touching the file', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost delta\n    hostname x\n`);
    const runner: CommandRunner = () => ({ stdout: 'host delta\nhostname x\n', status: 0 });
    assert.throws(() => validateAndCommit(runner, () => ({ hosts: [{ Name: 'del*', Config: {} }] }), cfg), /concrete pattern token, and unique/);
    assert.throws(() => validateAndCommit(runner, () => ({ hosts: [{ Name: 'a', Config: {} }, { Name: 'a', Config: {} }] }), cfg), /concrete pattern token, and unique/);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), `Include ${CS_SSH_CONFIG_PATH}\n\nHost delta\n    hostname x\n`);
});

test('validateAndCommit edits the inventory read under the lock, so a prior edit is kept', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost delta\n    hostname x\n`);
    const runner: CommandRunner = (_c, args) => ({ stdout: fs.readFileSync(args[2], 'utf-8').split('\n').filter(l => l.startsWith('    ')).map(l => l.trim()).join('\n') + '\n', status: 0 });
    validateAndCommit(runner, hosts => ({ hosts: hosts.map(h => ({ ...h, Config: { ...h.Config, user: ['alice'] } })), edited: 'delta' }), cfg);
    validateAndCommit(runner, hosts => ({ hosts: hosts.map(h => ({ ...h, Config: { ...h.Config, port: ['2222'] } })), edited: 'delta' }), cfg);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), renderCanonicalConfig([{ Name: 'delta', Config: { hostname: ['x'], port: ['2222'], user: ['alice'] } }]));
});

test('validateAndCommit atomically commits the canonical text with mode 0600 once every host validates', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost delta\n    hostname x\n`);
    const hosts: SSHHost[] = [{ Name: 'delta', Config: { hostname: ['x'], user: ['alice'] } }];
    const runner: CommandRunner = () => ({ stdout: 'host delta\nhostname x\nuser alice\n', status: 0 });
    validateAndCommit(runner, () => ({ hosts, edited: 'delta' }), cfg);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), renderCanonicalConfig(hosts));
    assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(`${cfg}.tmp`), 'the temp file used for the atomic rename does not linger');
});

// -------------------------------------------------------------------------------------------------
// isConverted
// -------------------------------------------------------------------------------------------------

test('isConverted recognizes only the marker convertToCanonical writes, not the bare Include ensureSshInclude adds', () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', `Include ${CS_SSH_CONFIG_PATH}\n\nHost x\n  HostName x\n`);
    assert.equal(isConverted(cfg), false);
    fs.writeFileSync(cfg, renderCanonicalConfig([{ Name: 'x', Config: { hostname: ['x'] } }]));
    assert.equal(isConverted(cfg), true);
});

test('convertToCanonical with no config yet writes the canonical file and no backup', () => {
    const dir = tmpDir();
    const cfg = path.join(dir, 'config');
    const backup = `${cfg}.csbridge-backup`;
    convertToCanonical(fakeSshRunner({}), cfg, backup);
    assert.equal(fs.readFileSync(cfg, 'utf-8'), renderCanonicalConfig([]));
    assert.ok(!fs.existsSync(backup));
});

// -------------------------------------------------------------------------------------------------
// Integration: the real `ssh -G` binary, only when it's on PATH — never touches the real ~/.ssh/config.
// -------------------------------------------------------------------------------------------------

const hasSsh = spawnSync('ssh', ['-V'], { encoding: 'utf-8' }).error === undefined;

test('importHosts resolves real aliases through the real ssh -G binary', { skip: !hasSsh }, () => {
    const dir = tmpDir();
    const cfg = write(dir, 'config', 'Host real\n  HostName example.com\n  User alice\n  Port 2222\n');
    const hosts = importHosts(systemRunner, cfg, dir);
    assert.deepEqual(hosts.map(h => h.Name), ['real']);
    assert.equal(hosts[0].Config.hostname?.[0], 'example.com');
    assert.equal(hosts[0].Config.user?.[0], 'alice');
    assert.equal(hosts[0].Config.port?.[0], '2222');
});

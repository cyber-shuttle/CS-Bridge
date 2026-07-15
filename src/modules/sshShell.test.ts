import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShellCommand, extractCommandResult, READY_MARKER, renderAuthHtml } from './sshShell';

// What the persistent login shell echoes back after running `cmd` with the given rid.
const reply = (rid: string, stdout: string, stderr: string, code: number) =>
    [`${stdout}\n__CSE_${rid}__ ${code}\n`, `${stderr}\n__CSE_${rid}__\n`] as const;

test('buildShellCommand runs the command then emits the exit code on stdout and a boundary on stderr', () => {
    const line = buildShellCommand('abc123', 'sinfo');
    assert.match(line, /^sinfo\n/); // command runs first
    assert.match(line, /__CSE_abc123__ %s\\n' "\$__cs"/); // exit code captured before the marker printf clobbers $?
    assert.match(line, /__CSE_abc123__\\n' 1>&2/); // stderr boundary
});

test('extractCommandResult returns null until both sentinels have arrived', () => {
    const rid = 'r1';
    assert.equal(extractCommandResult(rid, 'partial out', ''), null); // no markers yet
    assert.equal(extractCommandResult(rid, `done\n__CSE_${rid}__ 0\n`, 'no marker yet'), null); // stderr boundary missing
});

test('extractCommandResult splits stdout/stderr and parses a non-zero exit code', () => {
    const rid = 'r2';
    const [out, err] = reply(rid, 'job 5 RUNNING', 'a warning', 7);
    assert.deepEqual(extractCommandResult(rid, out, err), { stdout: 'job 5 RUNNING', stderr: 'a warning', code: 7 });
});

test('extractCommandResult yields empty strings when the command produced no output', () => {
    const rid = 'r3';
    const [out, err] = reply(rid, '', '', 0);
    assert.deepEqual(extractCommandResult(rid, out, err), { stdout: '', stderr: '', code: 0 });
});

test('extractCommandResult preserves output that ends without a trailing newline', () => {
    const rid = 'r4';
    // `printf x` (no newline) -> the injected leading \n still separates payload from the marker
    assert.deepEqual(extractCommandResult(rid, `x\n__CSE_${rid}__ 0\n`, `\n__CSE_${rid}__\n`), { stdout: 'x', stderr: '', code: 0 });
});

test('a unique rid keeps a colliding-looking payload from being mistaken for the sentinel', () => {
    const rid = 'deadbeef';
    const payload = '__CSE_other__ 9'; // looks like a marker but wrong rid
    const [out, err] = reply(rid, payload, '', 0);
    assert.deepEqual(extractCommandResult(rid, out, err), { stdout: payload, stderr: '', code: 0 });
});

test('READY_MARKER is a fixed, recognizable token', () => {
    assert.equal(typeof READY_MARKER, 'string');
    assert.ok(READY_MARKER.length > 0);
});

test('renderAuthHtml preserves QR block glyphs and newlines verbatim in the <pre>', () => {
    const prompt = 'Hit enter when done\n▀▀▀ ▄█▄ ▀▀▀\n█ ▄▄▄ █ ▀▄▀';
    const html = renderAuthHtml(prompt, 'NONCE123');
    assert.ok(html.includes(`<pre>${prompt}</pre>`)); // exact bytes + newlines, no reformatting
    assert.ok(html.includes(`script-src 'nonce-NONCE123'`)); // script gated by the nonce
});

test('renderAuthHtml turns an http(s) URL into a clickable link', () => {
    const url = 'https://cilogon.org/device/?user_code=XQG-V9K-3NV';
    assert.ok(renderAuthHtml(`Authenticate at ${url}`, 'N').includes(`<a href="${url}">${url}</a>`));
});

test('renderAuthHtml HTML-escapes the prompt so markup in it cannot inject', () => {
    const html = renderAuthHtml('user & <b>host</b>', 'N');
    assert.ok(html.includes('user &amp; &lt;b&gt;host&lt;/b&gt;'));
});

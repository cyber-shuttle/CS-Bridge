import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');

function testFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { return testFilesUnder(full); }
        return e.name.endsWith('.test.ts') ? [path.relative(root, full)] : [];
    });
}

const globToRegExp = (glob: string): RegExp =>
    new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

// npm test names directories explicitly, so a test file placed anywhere else would never run and
// the suite would still exit 0. This fails instead.
test('every *.test.ts under src is reachable by the npm test globs', () => {
    const script = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { scripts: Record<string, string> }).scripts.test;
    const globs = script.split(/\s+/).filter(a => a.endsWith('.test.ts')).map(globToRegExp);
    assert.ok(globs.length, 'the test script must name at least one *.test.ts pattern');

    const unreachable = testFilesUnder(path.join(root, 'src'))
        .map(f => f.split(path.sep).join('/'))
        .filter(f => !globs.some(g => g.test(f)));
    assert.deepEqual(unreachable, [], 'these test files would never run');
});

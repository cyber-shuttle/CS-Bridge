import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJson, updateJson, deleteFile, updateTextFile } from './fsSupport';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fss-')), 'store.json');

test('readJson / updateJson / deleteFile: RMW sees current value, null skips, missing → undefined', () => {
    const f = tmpFile();
    assert.equal(readJson(f), undefined); // missing
    updateJson<{ n: number }>(f, cur => ({ n: (cur?.n ?? 0) + 1 }));
    updateJson<{ n: number }>(f, cur => ({ n: (cur?.n ?? 0) + 1 }));
    assert.deepEqual(readJson(f), { n: 2 }); // mutator saw the prior value
    updateJson<{ n: number }>(f, () => null); // null = no-op
    assert.deepEqual(readJson(f), { n: 2 });
    assert.equal(fs.existsSync(`${f}.tmp`), false);
    deleteFile(f);
    assert.equal(readJson(f), undefined);
    deleteFile(f); // no throw when already gone
});

test('updateTextFile: missing → undefined, RMW appends, null skips (no file created), atomic', () => {
    const f = tmpFile();
    updateTextFile(f, cur => (cur === undefined ? null : cur + 'x')); // missing → null → no write
    assert.equal(fs.existsSync(f), false);
    updateTextFile(f, cur => (cur ?? '') + 'a');
    updateTextFile(f, cur => (cur ?? '') + 'b');
    assert.equal(fs.readFileSync(f, 'utf-8'), 'ab'); // transform saw the prior text
    assert.equal(fs.existsSync(`${f}.tmp`), false);
});

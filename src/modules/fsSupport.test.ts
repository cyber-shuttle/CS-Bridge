import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJsonArray, updateJsonArray } from './fsSupport';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fss-')), 'store.json');

test('readJsonArray: missing / unparseable / non-array all resolve to []', () => {
    const f = tmpFile();
    assert.deepEqual(readJsonArray(f), []);                 // ENOENT (first run)
    fs.writeFileSync(f, 'not json at all');
    assert.deepEqual(readJsonArray(f), []);                 // unparseable
    fs.writeFileSync(f, '{"not":"an array"}');
    assert.deepEqual(readJsonArray(f), []);                 // valid JSON, but not an array (hand-edited)
    fs.writeFileSync(f, '[1,2,3]');
    assert.deepEqual(readJsonArray<number>(f), [1, 2, 3]);
});

test('updateJsonArray: atomic write persists, null skips, in-place style works, no temp left behind', () => {
    const f = tmpFile();
    updateJsonArray<number>(f, arr => [...arr, 1]);
    updateJsonArray<number>(f, arr => [...arr, 2]);
    assert.deepEqual(readJsonArray(f), [1, 2]);             // returned array is written
    updateJsonArray<number>(f, () => null);                 // null = no-op (the runs-store dedup path)
    assert.deepEqual(readJsonArray(f), [1, 2]);
    updateJsonArray<number>(f, arr => { arr.push(3); return arr; }); // in-place-mutate style (sessions store)
    assert.deepEqual(readJsonArray(f), [1, 2, 3]);
    assert.equal(fs.existsSync(`${f}.tmp`), false);         // temp+rename leaves nothing behind
});

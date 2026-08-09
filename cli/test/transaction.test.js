'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { editPrefab } = require('../src/editor/index.js');
const { parsePrefab } = require('../src/parse.js');
const { writePrefab } = require('../src/write.js');
const { acquireFileLock, hashContent, releaseFileLock } = require('../src/transaction.js');
const { makeNode, makePrefabRoot } = require('../src/primitives.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-transaction-'));
  const filePath = path.join(dir, 'Fixture.prefab');
  fs.writeFileSync(filePath, JSON.stringify([
    makePrefabRoot({ name: 'Root', rootId: 1 }),
    makeNode({ name: 'Root', active: true }),
  ], null, 2) + '\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return filePath;
}

test('editPrefab returns revisions and accepts matching expectedHash', (t) => {
  const filePath = fixture(t);
  const beforeHash = hashContent(fs.readFileSync(filePath, 'utf8'));
  const result = editPrefab(filePath, [
    { op: 'set-active', node: 'Root', active: false },
  ], { expectedHash: beforeHash });

  assert.equal(result.beforeHash, beforeHash);
  assert.notEqual(result.afterHash, beforeHash);
  assert.equal(result.afterHash, hashContent(fs.readFileSync(filePath, 'utf8')));
  assert.equal(parsePrefab(filePath).elements[1]._active, false);
});

test('editPrefab rejects stale expectedHash without changing the file', (t) => {
  const filePath = fixture(t);
  const before = fs.readFileSync(filePath, 'utf8');
  assert.throws(() => editPrefab(filePath, [
    { op: 'set-active', node: 'Root', active: false },
  ], { expectedHash: '0'.repeat(64) }), /revision conflict/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('writePrefab detects an external change made after parsing', (t) => {
  const filePath = fixture(t);
  const parsed = parsePrefab(filePath);
  fs.appendFileSync(filePath, ' ');
  assert.throws(
    () => writePrefab(filePath, parsed.elements, parsed.raw),
    /changed while edit was in progress/
  );
});

test('editPrefab refuses a file lock held by another owner', (t) => {
  const filePath = fixture(t);
  const lockPath = acquireFileLock(filePath);
  try {
    assert.throws(() => editPrefab(filePath, [
      { op: 'set-active', node: 'Root', active: false },
    ]), /locked by another cocos-mcp process/);
  } finally {
    releaseFileLock(lockPath);
  }
});

test('atomic write leaves no temporary file beside the prefab', (t) => {
  const filePath = fixture(t);
  editPrefab(filePath, [{ op: 'set-active', node: 'Root', active: false }]);
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes('.cocos-mcp-')),
    []
  );
});

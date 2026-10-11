'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixture = require('./fixture-project');
const { editPrefab } = require('../src/editor');
const { formatPrefab } = require('../src/write');
const { handleOfflineToolCall } = require('../../router/src/offline-tools');

function copy(t) {
  const file = path.join(fixture.projectRoot, 'assets', randomUUID() + '.prefab');
  fs.copyFileSync(fixture.fixturePath, file);
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}
function options(dryRun) {
  return { projectRoot: fixture.projectRoot, store: fixture.store, operationId: randomUUID(), dryRun };
}

for (const dryRun of [false, true]) {
  test(`non-finite API inputs are rejected without resource changes (dryRun=${dryRun})`, t => {
    const file = copy(t);
    const before = fs.readFileSync(file);
    for (const value of [NaN, Infinity, -Infinity]) {
      const ops = [
        { op: 'set-position', node: 'touchArea', x: value, y: 0 },
        { op: 'set-component-field', node: 'btnMerge', componentType: 'cc.UITransform', property: '_custom', value: { items: [value] } },
        { op: 'add-component', node: 'touchArea', componentType: 'cc.UITransform', props: { _custom: { value } } },
        { op: 'set-active', node: { id: value }, active: true },
      ];
      for (const op of ops) {
        assert.throws(() => editPrefab(file, [op], options(dryRun)), /非有限数/);
        assert.deepEqual(fs.readFileSync(file), before);
      }
    }
  });

  test(`finite operands that overflow are rejected before serialization (dryRun=${dryRun})`, t => {
    const file = copy(t);
    const before = fs.readFileSync(file);
    assert.throws(() => editPrefab(file, [
      { op: 'set-position', node: 'touchArea', x: 1e308, y: 0 },
      { op: 'adjust-position', node: 'touchArea', dx: 1e308 },
    ], options(dryRun)), /非有限数/);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  test(`offline MCP entry rejects overflow JSON and client-serialized null (dryRun=${dryRun})`, async t => {
    const file = copy(t);
    const before = fs.readFileSync(file);
    for (const number of ['1e400', '-1e400']) {
      const ops = JSON.parse(`[{"op":"set-position","node":"touchArea","x":${number},"y":0}]`);
      await assert.rejects(handleOfflineToolCall('prefab_edit', {
        filePath: file, ops, ...options(dryRun),
      }, { store: fixture.store }), /非有限数/);
      await assert.rejects(handleOfflineToolCall('prefab_edit', {
        filePath: file, ops: JSON.parse(JSON.stringify(ops)), ...options(dryRun),
      }, { store: fixture.store }), /类型应为 number/);
      assert.deepEqual(fs.readFileSync(file), before);
    }
  });
}

test('Prefab formatter rejects nested non-finite numbers, including custom component data', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => formatPrefab([{ custom: { items: [value] } }], '[]\n'), /非有限数/);
  }
});

test('finite positions and custom component numbers retain their values', t => {
  const file = copy(t);
  editPrefab(file, [
    { op: 'set-position', node: 'touchArea', x: -12.5, y: 1e308, z: 3 },
    { op: 'set-component-field', node: 'btnMerge', componentType: 'cc.UITransform', property: '_custom', value: { items: [0, 7, 0.125, null] } },
  ], options(false));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data.find(item => item._name === 'touchArea')._lpos, { __type__: 'cc.Vec3', x: -12.5, y: 1e308, z: 3 });
  assert.deepEqual(data.find(item => item.__type__ === 'cc.UITransform')._custom, { items: [0, 7, 0.125, null] });
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Keep the pre-fix prototype pollution reproduction out of the test runner.
function isolated(check) {
  const result = spawnSync(process.execPath, ['-e', `(${check})();`], {
    cwd: __dirname, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('property paths: every op rejects prototype segments before dry-run or writes', () => isolated(() => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const { randomUUID } = require('node:crypto');
  const { fixturePath, projectRoot, store } = require('./fixture-project');
  const { editPrefab } = require('../src/editor');
  const before = fs.readFileSync(fixturePath);
  const ops = [
    { op: 'set-component-ref', node: 'btnMerge', componentType: 'cc.UITransform', refNode: 'HomeUI' },
    { op: 'set-component-field', node: 'btnMerge', componentType: 'cc.UITransform', value: 7 },
    { op: 'bulk-set', selector: { byNamePrefix: 'btn' }, target: 'node', value: 7 },
    { op: 'set-nested-component-field', node: 'taskEntry', componentType: 'cc.UITransform', value: 7 },
    { op: 'set-nested-node-field', node: 'taskEntry', subNode: 'MovableChild', value: 7 },
    { op: 'reset-overrides', node: 'taskEntry' },
  ];
  const failures = [];
  for (const dryRun of [false, true]) {
    for (const op of ops) {
      for (const segment of ['__proto__', 'constructor', 'prototype']) {
        for (const property of [segment, [segment, '__cocosReviewMarker'], ['_items', '0', segment]]) {
          const properties = op.op === 'set-component-ref' && Array.isArray(property)
            ? [property, property.join('.'), property.join('.').replace('.0.', '[0].')]
            : [property];
          for (const input of properties) {
            try {
              assert.throws(() => editPrefab(fixturePath, [{ ...op, property: input }], {
                projectRoot, store, operationId: randomUUID(), dryRun,
              }), /不安全的 property 路径/);
              assert.equal(Object.hasOwn(Object.prototype, '__cocosReviewMarker'), false);
              assert.equal(({}).__cocosReviewMarker, undefined);
              assert.deepEqual(fs.readFileSync(fixturePath), before);
            } catch (error) {
              failures.push(`${op.op} ${JSON.stringify(input)} dryRun=${dryRun}: ${error.message}`);
            } finally {
              delete Object.prototype.__cocosReviewMarker;
              fs.writeFileSync(fixturePath, before);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
}));

test('property path writers never descend into inherited objects', () => isolated(() => {
  const assert = require('node:assert/strict');
  const { parsePrefab } = require('../src/parse');
  const { fixturePath } = require('./fixture-project');
  const { execSetComponentRef } = require('../src/editor/ops/set-component-ref');
  const { execSetComponentField } = require('../src/editor/ops/set-component-field');
  const { execBulkSet } = require('../src/editor/ops/bulk-set');
  const inherited = {};
  Object.prototype.__cocosInheritedObject = inherited;
  try {
    const data = parsePrefab(fixturePath);
    const component = data.elements.find(item => item.__type__ === 'cc.UITransform');
    const base = { node: 'btnMerge', componentType: 'cc.UITransform' };
    assert.throws(() => execSetComponentField(data, {
      ...base, property: ['__cocosInheritedObject', 'value'], value: 7,
    }), /不是对象/);
    assert.throws(() => execBulkSet(data, {
      selector: { byNamePrefix: 'btn' }, target: 'node',
      property: ['__cocosInheritedObject', 'value'], value: 7,
    }), /不是对象/);
    execSetComponentRef(data, {
      ...base, property: '__cocosInheritedObject.target', refNode: 'HomeUI',
    });
    assert.deepEqual(inherited, {});
    assert.equal(Object.hasOwn(component, '__cocosInheritedObject'), true);
    assert.equal(data.elements[component.__cocosInheritedObject.target.__id__]._name, 'HomeUI');
  } finally {
    delete Object.prototype.__cocosInheritedObject;
  }
}));

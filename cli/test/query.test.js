'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { queryPrefab } = require('../src/query/index.js');
const { createFixtureProject } = require('./helpers/fixture-project.js');

function flattenTree(node) {
  return [node, ...(node.children || []).flatMap(flattenTree)];
}

test('query tree: 默认返回精简节点树，普通节点不暴露 overrides', (t) => {
  const fixture = createFixtureProject(t, 'query-tree');
  const tree = queryPrefab(fixture.hostPath);

  assert.equal(tree.name, fixture.names.root);
  assert.equal(tree.type, 'cc.Node');
  assert.equal(tree.isStub, false);
  assert.ok(Array.isArray(tree.children));
  assert.ok(Array.isArray(tree.componentTypes));

  const ordinary = flattenTree(tree).filter((node) => !node.isStub);
  assert.ok(ordinary.length > 1);
  assert.ok(ordinary.every((node) => !Object.hasOwn(node, 'overrides')));
});

test('query tree/node: nested stub 使用 override 名称并返回有效 overrides', (t) => {
  const fixture = createFixtureProject(t, 'query-stub');
  const tree = queryPrefab(fixture.hostPath, { type: 'tree' });
  const stub = flattenTree(tree).find((node) => node.isStub);

  assert.ok(stub);
  assert.equal(stub.name, `${fixture.names.nested} (stub)`);
  assert.ok(stub.overrides.length >= 2);
  assert.ok(stub.overrides.every((item) => item.propertyPath.length > 0));

  const node = queryPrefab(fixture.hostPath, {
    type: 'node',
    name: fixture.names.nested,
  });
  assert.equal(node.id, stub.id);
  assert.equal(node.isStub, true);
  assert.equal(node.stubAsset, fixture.nestedUuid);
});

test('query node: 普通节点返回详情，不存在名称返回 null', (t) => {
  const fixture = createFixtureProject(t, 'query-node');
  const node = queryPrefab(fixture.hostPath, {
    type: 'node',
    name: fixture.names.plain,
  });

  assert.equal(node.name, fixture.names.plain);
  assert.equal(node.type, 'cc.Node');
  assert.equal(node.isStub, false);
  assert.ok(node.raw);
  assert.ok(!Object.hasOwn(node, 'overrides'));
  assert.equal(
    queryPrefab(fixture.hostPath, { type: 'node', name: '__missing__' }),
    null
  );
});

test('query find/field: 按类型查 id，并读取组件字段', (t) => {
  const fixture = createFixtureProject(t, 'query-find-field');
  const nodeIds = queryPrefab(fixture.hostPath, {
    type: 'find',
    nodeType: 'cc.Node',
  });
  const instanceIds = queryPrefab(fixture.hostPath, {
    type: 'find',
    nodeType: 'cc.PrefabInstance',
  });
  const missing = queryPrefab(fixture.hostPath, {
    type: 'find',
    nodeType: 'cc.DoesNotExist',
  });

  assert.ok(nodeIds.length >= 6);
  assert.equal(instanceIds.length, 1);
  assert.deepEqual(missing, []);
  assert.equal(
    queryPrefab(fixture.hostPath, {
      type: 'field',
      name: fixture.names.label,
      componentType: 'cc.Label',
      field: '_string',
    }),
    'Start'
  );
});

test('query overrides: 正确识别 stub 根字段落点', (t) => {
  const fixture = createFixtureProject(t, 'query-overrides');
  const result = queryPrefab(fixture.hostPath, {
    type: 'overrides',
    node: fixture.names.nested,
  });

  assert.equal(result.nestedPrefab, fixture.nestedPath);
  assert.deepEqual(
    result.propertyOverrides.map((item) => item.propertyPath[0]).sort(),
    ['_lpos', '_name']
  );
  assert.ok(
    result.propertyOverrides.every((item) => item.target.kind === 'stub-node-field')
  );
});

test('query: 缺少 selector 参数或未知类型时给出明确错误', (t) => {
  const fixture = createFixtureProject(t, 'query-errors');

  assert.throws(
    () => queryPrefab(fixture.hostPath, { type: 'node' }),
    /selector\.name/
  );
  assert.throws(
    () => queryPrefab(fixture.hostPath, { type: 'find' }),
    /selector\.nodeType/
  );
  assert.throws(
    () => queryPrefab(fixture.hostPath, { type: 'field', name: fixture.names.label }),
    /componentType/
  );
  assert.throws(
    () => queryPrefab(fixture.hostPath, { type: 'unknown' }),
    /未知.*selector\.type/
  );
});

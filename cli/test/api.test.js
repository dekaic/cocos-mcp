'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { editPrefab } = require('../src/editor/index.js');
const { parsePrefab } = require('../src/parse.js');
const { listOverrides } = require('../src/overrides.js');
const { addRootTargetOverride } = require('../src/editor/nested.js');
const { compressUuid } = require('../src/id.js');
const {
  createFixtureProject,
  findNodeId,
  parseWithResolver,
} = require('./helpers/fixture-project.js');

function nodeId(parsed, name) {
  return findNodeId(parsed, name);
}

function componentOf(parsed, nodeName, componentType) {
  const node = parsed.findNodeByName(nodeName);
  if (!node) return null;
  for (const componentRef of node._components || []) {
    const component = parsed.elements[componentRef.__id__];
    if (component && component.__type__ === componentType) return component;
  }
  return null;
}

test('editPrefab: 普通节点支持数字 selector、字段编辑和混合 batch', (t) => {
  const fixture = createFixtureProject(t, 'edit-basic');
  const before = parsePrefab(fixture.hostPath);
  const plainId = nodeId(before, fixture.names.plain);
  const newSpriteUuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff@f9941';

  const result = editPrefab(fixture.hostPath, [
    { op: 'set-position', node: plainId, x: 111, y: 222, z: 5 },
    { op: 'set-active', node: fixture.names.plain, active: false },
    { op: 'set-label-text', node: fixture.names.label, text: 'Updated' },
    { op: 'set-sprite-frame', node: fixture.names.sprite, uuid: newSpriteUuid },
  ]);

  assert.equal(result.changed, true);
  assert.equal(result.opsApplied, 4);
  const after = parsePrefab(fixture.hostPath);
  const plain = after.findNodeByName(fixture.names.plain);
  assert.deepEqual(
    { x: plain._lpos.x, y: plain._lpos.y, z: plain._lpos.z },
    { x: 111, y: 222, z: 5 }
  );
  assert.equal(plain._active, false);
  assert.equal(componentOf(after, fixture.names.label, 'cc.Label')._string, 'Updated');
  assert.equal(
    componentOf(after, fixture.names.sprite, 'cc.Sprite')._spriteFrame.__uuid__,
    newSpriteUuid
  );
});

test('editPrefab: dry-run 不落盘，batch 中任一失败时原子回滚', (t) => {
  const fixture = createFixtureProject(t, 'edit-atomic');
  const original = fs.readFileSync(fixture.hostPath, 'utf8');

  const dryRun = editPrefab(fixture.hostPath, [
    { op: 'set-position', node: fixture.names.plain, x: 9, y: 8 },
  ], { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.ok(dryRun.diff.length > 0);
  assert.equal(fs.readFileSync(fixture.hostPath, 'utf8'), original);

  assert.throws(() => {
    editPrefab(fixture.hostPath, [
      { op: 'set-active', node: fixture.names.plain, active: false },
      { op: 'set-position', node: '__missing__', x: 1, y: 2 },
    ]);
  }, /找不到节点/);
  assert.equal(fs.readFileSync(fixture.hostPath, 'utf8'), original);
});

test('editPrefab: stub 节点字段通过 propertyOverrides 写入', (t) => {
  const fixture = createFixtureProject(t, 'edit-stub');
  const before = parseWithResolver(fixture.hostPath);
  const stubId = nodeId(before, fixture.names.nested);

  editPrefab(fixture.hostPath, [
    { op: 'set-position', node: stubId, x: 99, y: -88, z: 4 },
    { op: 'set-active', node: { id: stubId }, active: false },
  ], { projectRoot: fixture.root });

  const after = parseWithResolver(fixture.hostPath);
  const overrides = listOverrides(after, stubId);
  const position = overrides.find((item) => item.propertyPath[0] === '_lpos');
  const active = overrides.find((item) => item.propertyPath[0] === '_active');
  assert.deepEqual(
    { x: position.value.x, y: position.value.y, z: position.value.z },
    { x: 99, y: -88, z: 4 }
  );
  assert.equal(active.value, false);
});

test('add-node: 创建节点、UITransform 和互不冲突的 fileId', (t) => {
  const fixture = createFixtureProject(t, 'add-node');

  editPrefab(fixture.hostPath, [
    {
      op: 'add-node',
      parent: fixture.names.plain,
      node: {
        name: 'Generated',
        lpos: [10, 20, 3],
        components: ['UITransform'],
        width: 200,
        height: 80,
      },
    },
    {
      op: 'add-node',
      parent: fixture.names.plain,
      node: { name: 'Generated' },
    },
  ]);

  const parsed = parsePrefab(fixture.hostPath);
  const generated = parsed.elements
    .map((item, id) => ({ item, id }))
    .filter(({ item }) => item && item.__type__ === 'cc.Node' && item._name === 'Generated');
  assert.equal(generated.length, 2);
  assert.ok(generated.every(({ item }) => item._parent.__id__ === nodeId(parsed, fixture.names.plain)));

  const withUi = generated.find(({ item }) => item._components.length === 1).item;
  const ui = parsed.elements[withUi._components[0].__id__];
  assert.equal(ui.__type__, 'cc.UITransform');
  assert.equal(ui._contentSize.width, 200);
  assert.equal(ui._contentSize.height, 80);

  const fileIds = generated.map(({ item }) => parsed.elements[item._prefab.__id__].fileId);
  assert.equal(new Set(fileIds).size, 2);
});

test('clone/remove-node: 复制子树并递归断开被删除子树', (t) => {
  const fixture = createFixtureProject(t, 'clone-remove');

  editPrefab(fixture.hostPath, [
    { op: 'add-node', parent: fixture.names.plain, node: { name: 'SourceRoot' } },
    { op: 'add-node', parent: 'SourceRoot', node: { name: 'SourceChild' } },
    {
      op: 'clone-node',
      source: 'SourceRoot',
      parent: fixture.names.plain,
      name: 'ClonedRoot',
    },
  ]);

  let parsed = parsePrefab(fixture.hostPath);
  const sourceId = nodeId(parsed, 'SourceRoot');
  const sourceChildId = nodeId(parsed, 'SourceChild');
  const clone = parsed.findNodeByName('ClonedRoot');
  assert.ok(clone);
  assert.equal(clone._parent.__id__, nodeId(parsed, fixture.names.plain));
  assert.equal(clone._children.length, 1);
  assert.equal(parsed.elements[clone._children[0].__id__]._parent.__id__, parsed.elements.indexOf(clone));

  editPrefab(fixture.hostPath, [{ op: 'remove-node', target: 'SourceRoot' }]);
  parsed = parsePrefab(fixture.hostPath);
  assert.equal(parsed.elements[sourceId]._parent, null);
  assert.equal(parsed.elements[sourceChildId]._parent, null);
  assert.ok(
    !parsed.findNodeByName(fixture.names.plain)._children.some((ref) => ref.__id__ === sourceId)
  );
});

test('mounted child: stub 下新增和删除节点会同步 PrefabInstance', (t) => {
  const fixture = createFixtureProject(t, 'mounted-child');
  let parsed = parseWithResolver(fixture.hostPath);
  const stubId = nodeId(parsed, fixture.names.nested);

  editPrefab(fixture.hostPath, [
    { op: 'add-node', parent: { id: stubId }, node: { name: 'MountedChild' } },
  ], { projectRoot: fixture.root });

  parsed = parseWithResolver(fixture.hostPath);
  const mounted = parsed.elements.find(
    (item) => item && item.__type__ === 'cc.Node' && item._name === 'MountedChild'
  );
  const mountedId = parsed.elements.indexOf(mounted);
  const stub = parsed.elements[stubId];
  const prefabInfo = parsed.elements[stub._prefab.__id__];
  const instanceId = prefabInfo.instance.__id__;
  assert.ok(parsed.elements[instanceId].mountedChildren.some((ref) => ref.__id__ === mountedId));
  assert.equal(mounted._parent.__id__, stubId);

  editPrefab(fixture.hostPath, [{ op: 'remove-node', target: { id: mountedId } }]);
  parsed = parseWithResolver(fixture.hostPath);
  assert.equal(parsed.elements[mountedId]._parent, null);
  assert.ok(!parsed.elements[instanceId].mountedChildren.some((ref) => ref.__id__ === mountedId));
});

test('remove-node: 删除 stub 会清理 instance、nested roots 和指向它的 override', (t) => {
  const fixture = createFixtureProject(t, 'remove-stub');
  const parsed = parseWithResolver(fixture.hostPath);
  const stubId = nodeId(parsed, fixture.names.nested);
  const stub = parsed.elements[stubId];
  const stubPrefabInfoId = stub._prefab.__id__;
  const instanceId = parsed.elements[stubPrefabInfoId].instance.__id__;
  const sourceCompId = componentOf(parsed, fixture.names.componentHost, 'cc.UITransform');
  const sourceId = parsed.elements.indexOf(sourceCompId);

  addRootTargetOverride(
    parsed,
    parsed.rootId,
    sourceId,
    ['_nested'],
    stubId,
    [fixture.nestedRootFileId]
  );
  fs.writeFileSync(fixture.hostPath, JSON.stringify(parsed.elements, null, 2) + '\n', 'utf8');

  editPrefab(fixture.hostPath, [{ op: 'remove-node', target: { id: stubId } }]);
  const after = parsePrefab(fixture.hostPath);
  const root = after.getRoot();
  const rootPrefabInfo = after.elements[root._prefab.__id__];
  assert.deepEqual(rootPrefabInfo.nestedPrefabInstanceRoots, []);
  assert.deepEqual(rootPrefabInfo.targetOverrides, []);
  assert.equal(after.elements[stubPrefabInfoId].instance, null);
  assert.deepEqual(after.elements[instanceId].propertyOverrides, []);
  assert.equal(after.elements[stubId]._parent, null);
});

test('component ops: className 规范化、属性、节点/组件/数组引用和移除', (t) => {
  const fixture = createFixtureProject(t, 'component-ops');
  const type = compressUuid(fixture.componentUuid);

  const result = editPrefab(fixture.hostPath, [
    {
      op: 'add-component',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
      props: { _score: 42 },
    },
    {
      op: 'set-component-ref',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
      property: '_target',
      refNode: fixture.names.root,
    },
    {
      op: 'set-component-ref',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
      property: '_ui',
      refNode: fixture.names.componentHost,
      refType: 'cc.UITransform',
    },
    {
      op: 'set-component-ref',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
      property: '_items.0',
      refNode: fixture.names.root,
    },
    {
      op: 'set-component-ref',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
      property: '_items[1]',
      refNode: fixture.names.plain,
    },
  ], { projectRoot: fixture.root });
  assert.equal(result.opsApplied, 5);

  let parsed = parsePrefab(fixture.hostPath);
  const component = componentOf(parsed, fixture.names.componentHost, type);
  assert.ok(component);
  assert.equal(component._score, 42);
  assert.equal(parsed.elements[component._target.__id__]._name, fixture.names.root);
  assert.equal(parsed.elements[component._ui.__id__].__type__, 'cc.UITransform');
  assert.equal(parsed.elements[component._items[0].__id__]._name, fixture.names.root);
  assert.equal(parsed.elements[component._items[1].__id__]._name, fixture.names.plain);
  const componentId = parsed.elements.indexOf(component);

  editPrefab(fixture.hostPath, [
    {
      op: 'remove-component',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
    },
  ], { projectRoot: fixture.root });
  parsed = parsePrefab(fixture.hostPath);
  assert.equal(componentOf(parsed, fixture.names.componentHost, type), null);
  assert.equal(parsed.elements[componentId].__type__, type, '被移除组件保留为稳定 id 的 orphan');
});

test('component ops: 重复、未知 className 和缺字段失败时不落盘', (t) => {
  const fixture = createFixtureProject(t, 'component-errors');
  editPrefab(fixture.hostPath, [
    {
      op: 'add-component',
      node: fixture.names.componentHost,
      componentType: 'FixtureComponent',
    },
  ], { projectRoot: fixture.root });
  const before = fs.readFileSync(fixture.hostPath, 'utf8');

  assert.throws(() => {
    editPrefab(fixture.hostPath, [
      {
        op: 'add-component',
        node: fixture.names.componentHost,
        componentType: 'FixtureComponent',
      },
    ], { projectRoot: fixture.root });
  }, /已挂/);
  assert.equal(fs.readFileSync(fixture.hostPath, 'utf8'), before);

  assert.throws(() => {
    editPrefab(fixture.hostPath, [
      {
        op: 'add-component',
        node: fixture.names.plain,
        componentType: 'MissingFixtureComponent',
      },
    ], { projectRoot: fixture.root });
  }, /找不到对应 \.ts\.meta/);
  assert.equal(fs.readFileSync(fixture.hostPath, 'utf8'), before);

  assert.throws(
    () => editPrefab(fixture.hostPath, [
      { op: 'remove-component', node: fixture.names.componentHost },
    ]),
    /缺必填字段 "componentType"/
  );
});

test('nested error: stub 依赖 UUID 不存在时给出明确错误且不落盘', (t) => {
  const fixture = createFixtureProject(t, 'nested-error');
  const parsed = parsePrefab(fixture.hostPath);
  const stubId = nodeId(parsed, fixture.names.nested);
  const prefabInfo = parsed.elements[parsed.elements[stubId]._prefab.__id__];
  const missingUuid = '00000000-0000-4000-8000-000000000000';
  prefabInfo.asset.__uuid__ = missingUuid;
  fs.writeFileSync(fixture.hostPath, JSON.stringify(parsed.elements, null, 2) + '\n', 'utf8');
  const before = fs.readFileSync(fixture.hostPath, 'utf8');

  assert.throws(() => {
    editPrefab(fixture.hostPath, [
      {
        op: 'set-sprite-frame',
        node: { id: stubId },
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@f9941',
      },
    ], { projectRoot: fixture.root });
  }, new RegExp(missingUuid));
  assert.equal(fs.readFileSync(fixture.hostPath, 'utf8'), before);
});

test('addRootTargetOverride: 数组路径独立且同一路径更新时保持幂等', () => {
  const elements = [
    {
      __type__: 'cc.PrefabInfo',
      instance: null,
      targetOverrides: null,
      root: { __id__: 1 },
      asset: null,
    },
    { __type__: 'cc.Node', _name: 'Root', _prefab: { __id__: 0 } },
    { __type__: 'SomeComp' },
    { __type__: 'cc.Node' },
  ];
  const prefabData = { elements, rootId: 1 };

  addRootTargetOverride(prefabData, 1, 2, ['_items', 0], 3, ['fid-A']);
  addRootTargetOverride(prefabData, 1, 2, ['_items', 1], 3, ['fid-B']);
  addRootTargetOverride(prefabData, 1, 2, ['_items', 0], 3, ['fid-C']);

  assert.equal(elements[0].targetOverrides.length, 2);
  const overrides = elements[0].targetOverrides.map((item) => elements[item.__id__]);
  const first = overrides.find((item) => item.propertyPath[1] === 0);
  const second = overrides.find((item) => item.propertyPath[1] === 1);
  assert.deepEqual(elements[first.targetInfo.__id__].localID, ['fid-C']);
  assert.deepEqual(elements[second.targetInfo.__id__].localID, ['fid-B']);
});

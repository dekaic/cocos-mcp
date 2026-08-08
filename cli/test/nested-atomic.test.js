'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { editPrefab } = require('../src/editor/index.js');
const { parsePrefab } = require('../src/parse.js');
const { queryPrefab } = require('../src/query/index.js');
const { listOverrides } = require('../src/overrides.js');
const {
  clearCache: clearClassIdCache,
  resolveClassIdByName,
} = require('../src/classid-resolver.js');
const {
  clearCache: clearUuidCache,
  getUuidIndex,
  resolveUuidToPath,
} = require('../src/uuid-resolver.js');
const { compressUuid } = require('../src/id.js');
const { makeNode, makePrefabInfo, makePrefabRoot } = require('../src/primitives.js');

const TEMP_ROOTS = [];
const NESTED_UUID = '11111111-2222-4333-8444-555555555555';
const INNER_ROOT_FILE_ID = 'innerRootFileId';

after(() => {
  clearClassIdCache();
  clearUuidCache();
  for (const dir of TEMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

function makePrefab(name, rootFileId) {
  return [
    makePrefabRoot({ name, rootId: 1 }),
    makeNode({ name, parentId: null, prefabId: 2 }),
    makePrefabInfo({ rootId: 1, fileId: rootFileId }),
  ];
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function makeProject(tag, withNested) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cocos-mcp-${tag}-`));
  TEMP_ROOTS.push(root);
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  writeJson(path.join(root, 'package.json'), { name: tag, version: '1.0.0' });

  const hostPath = path.join(assets, 'Host.prefab');
  writeJson(hostPath, makePrefab('HostRoot', 'hostRootFileId'));

  if (withNested) {
    const nestedPath = path.join(assets, 'Inner.prefab');
    writeJson(nestedPath, makePrefab('InnerRoot', INNER_ROOT_FILE_ID));
    writeJson(nestedPath + '.meta', { uuid: NESTED_UUID });
  }

  return { root, assets, hostPath };
}

test('add-nested-prefab: name/lpos override 使用嵌套 prefab 根 fileId，query 归类为 stub-node-field', () => {
  const project = makeProject('nested-root-id', true);

  editPrefab(project.hostPath, [
    {
      op: 'add-nested-prefab',
      parent: 'HostRoot',
      prefabUuid: NESTED_UUID,
      name: 'RenamedInner',
      lpos: [12, 34, 5],
    },
  ], { projectRoot: project.root });

  const parsed = parsePrefab(project.hostPath);
  parsed.resolverStartPath = project.hostPath;
  const stubPrefabInfo = parsed.elements.find(
    (el) => el && el.__type__ === 'cc.PrefabInfo' &&
      el.asset && el.asset.__uuid__ === NESTED_UUID
  );
  assert.ok(stubPrefabInfo, '应生成指向子 prefab 的 PrefabInfo');
  assert.notEqual(stubPrefabInfo.fileId, INNER_ROOT_FILE_ID, '测试前提：外层 stub fileId 应与子 prefab 根 fileId 不同');

  const instance = parsed.elements[stubPrefabInfo.instance.__id__];
  assert.equal(instance.propertyOverrides.length, 2);
  for (const overrideRef of instance.propertyOverrides) {
    const override = parsed.elements[overrideRef.__id__];
    const targetInfo = parsed.elements[override.targetInfo.__id__];
    assert.deepEqual(targetInfo.localID, [INNER_ROOT_FILE_ID]);
  }

  const stubId = stubPrefabInfo.root.__id__;
  const queried = queryPrefab(project.hostPath, {
    type: 'overrides',
    node: { id: stubId },
  });
  assert.deepEqual(
    queried.propertyOverrides.map((item) => item.propertyPath[0]).sort(),
    ['_lpos', '_name']
  );
  assert.ok(
    queried.propertyOverrides.every((item) => item.target.kind === 'stub-node-field'),
    '子 prefab 根 fileId 对应的 name/lpos 应归类为 stub 节点字段'
  );

  assert.deepEqual(
    listOverrides(parsed, stubId).map((item) => item.propertyPath[0]).sort(),
    ['_lpos', '_name'],
    '低层 override API 也应识别子 prefab 根 fileId'
  );
});

test('add-nested-prefab: UUID miss 会刷新长驻 Router 索引', () => {
  const project = makeProject('nested-cache-refresh', false);
  clearUuidCache();
  assert.equal(getUuidIndex(project.root).has(NESTED_UUID), false, '先预热不包含新 Prefab 的索引');

  const nestedPath = path.join(project.assets, 'Inner.prefab');
  writeJson(nestedPath, makePrefab('InnerRoot', INNER_ROOT_FILE_ID));
  writeJson(nestedPath + '.meta', { uuid: NESTED_UUID });

  editPrefab(project.hostPath, [
    {
      op: 'add-nested-prefab',
      parent: 'HostRoot',
      prefabUuid: NESTED_UUID,
      name: 'LateInner',
    },
  ], { projectRoot: project.root });

  assert.equal(queryPrefab(project.hostPath, { type: 'tree' }).children[0].name, 'LateInner (stub)');
});

test('set-nested-component-field: subNode 数组写入完整 localID 链并可精确 reset', () => {
  const project = makeProject('nested-subnode-chain', true);
  const nestedPath = path.join(project.assets, 'Inner.prefab');
  const nested = JSON.parse(fs.readFileSync(nestedPath, 'utf8'));
  nested[1]._children = [{ __id__: 3 }];
  nested.push({
    __type__: 'cc.Node', _name: 'LabelNode', _objFlags: 0, __editorExtras__: {},
    _parent: { __id__: 1 }, _children: [], _active: true, _components: [{ __id__: 5 }],
    _prefab: { __id__: 4 }, _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
  });
  nested.push(makePrefabInfo({ rootId: 1, fileId: 'label-node-file-id' }));
  nested.push({ __type__: 'cc.Label', node: { __id__: 3 }, __prefab: { __id__: 6 }, _string: 'old' });
  nested.push({ __type__: 'cc.CompPrefabInfo', fileId: 'label-comp-file-id' });
  writeJson(nestedPath, nested);

  editPrefab(project.hostPath, [{
    op: 'add-nested-prefab', parent: 'HostRoot', prefabUuid: NESTED_UUID, name: 'Inner',
  }], { projectRoot: project.root });
  editPrefab(project.hostPath, [{
    op: 'set-nested-component-field', node: 'Inner', componentType: 'cc.Label',
    property: '_string', value: 'new', subNode: ['InnerRoot', 'LabelNode'],
  }], { projectRoot: project.root });

  let parsed = parsePrefab(project.hostPath);
  const instance = parsed.elements.find((el) => el && el.__type__ === 'cc.PrefabInstance');
  const override = parsed.elements[instance.propertyOverrides.at(-1).__id__];
  const targetInfo = parsed.elements[override.targetInfo.__id__];
  assert.deepEqual(targetInfo.localID, ['label-comp-file-id']);

  editPrefab(project.hostPath, [{
    op: 'reset-overrides', node: 'Inner', componentType: 'cc.Label',
    property: '_string', subNode: ['InnerRoot', 'LabelNode'],
  }], { projectRoot: project.root });
  parsed = parsePrefab(project.hostPath);
  const resetInstance = parsed.elements.find((el) => el && el.__type__ === 'cc.PrefabInstance');
  assert.equal(resetInstance.propertyOverrides.length, 1, '只保留 add-nested-prefab 的 _name override');
  const remaining = parsed.elements[resetInstance.propertyOverrides[0].__id__];
  assert.deepEqual(remaining.propertyPath, ['_name']);
});

test('UuidResolver: 命中已移动的旧路径时会刷新索引', () => {
  const project = makeProject('nested-move-refresh', true);
  const oldPath = path.join(project.assets, 'Inner.prefab');
  const newPath = path.join(project.assets, 'Moved.prefab');
  clearUuidCache();
  assert.equal(resolveUuidToPath(NESTED_UUID, project.root), oldPath);

  fs.renameSync(oldPath, newPath);
  fs.renameSync(oldPath + '.meta', newPath + '.meta');

  assert.equal(resolveUuidToPath(NESTED_UUID, project.root), newPath);
});

test('ensure-meta: 后续 op 失败时回滚本 batch 新建的 meta', () => {
  const project = makeProject('meta-rollback', false);
  const scriptsDir = path.join(project.assets, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, 'NewComponent.ts');
  fs.writeFileSync(scriptPath, "export class NewComponent {}\n", 'utf8');
  const metaPath = scriptPath + '.meta';
  const originalPrefab = fs.readFileSync(project.hostPath, 'utf8');

  assert.throws(() => {
    editPrefab(project.hostPath, [
      { op: 'ensure-meta', path: scriptPath },
      { op: 'set-position', node: '__missing__', x: 1, y: 2 },
    ], { projectRoot: project.root });
  }, /找不到节点/);

  assert.equal(fs.existsSync(metaPath), false, '后续 op 失败后不应残留新 meta');
  assert.equal(fs.readFileSync(project.hostPath, 'utf8'), originalPrefab, 'prefab 也不应落盘');
});

test('ensure-meta: 已有 meta 幂等且 changed=false', () => {
  const project = makeProject('meta-existing', false);
  const scriptPath = path.join(project.assets, 'Existing.ts');
  const metaPath = scriptPath + '.meta';
  fs.writeFileSync(scriptPath, "export class Existing {}\n", 'utf8');
  const existingMeta = '{"uuid":"existing-meta"}\n';
  fs.writeFileSync(metaPath, existingMeta, 'utf8');
  const originalPrefab = fs.readFileSync(project.hostPath, 'utf8');

  const result = editPrefab(project.hostPath, [
    { op: 'ensure-meta', path: scriptPath },
  ], { projectRoot: project.root });

  assert.equal(result.changed, false);
  assert.equal(result.opsApplied, 1);
  assert.equal(fs.readFileSync(metaPath, 'utf8'), existingMeta);
  assert.equal(fs.readFileSync(project.hostPath, 'utf8'), originalPrefab);
});

test('ensure-meta: 已有 meta 会失效长驻 Router 的 classId 缓存', () => {
  const project = makeProject('meta-cache-refresh', false);
  const scriptPath = path.join(project.assets, 'LateComponent.ts');
  const metaPath = scriptPath + '.meta';
  const uuid = '12345678-9abc-4def-8123-456789abcdef';
  fs.writeFileSync(
    scriptPath,
    "import { _decorator } from 'cc';\nconst { ccclass } = _decorator;\n@ccclass('LateComponent')\nexport class LateComponent {}\n",
    'utf8'
  );

  clearClassIdCache();
  assert.equal(resolveClassIdByName('LateComponent', project.root), null, '先预热一份未含 meta 的缓存');
  writeJson(metaPath, { uuid });

  const result = editPrefab(project.hostPath, [
    { op: 'ensure-meta', path: scriptPath },
    { op: 'add-component', node: 'HostRoot', componentType: 'LateComponent' },
  ], { projectRoot: project.root });

  assert.equal(result.changed, true);
  assert.ok(
    parsePrefab(project.hostPath).elements.some((item) => item && item.__type__ === compressUuid(uuid)),
    '同 batch 应读到外部刚生成的 meta'
  );
});

test('ensure-meta: 成功新建 meta 时 changed=true，不重写 prefab', () => {
  const project = makeProject('meta-created', false);
  const scriptPath = path.join(project.assets, 'Created.ts');
  fs.writeFileSync(scriptPath, "export class Created {}\n", 'utf8');
  const originalPrefab = fs.readFileSync(project.hostPath, 'utf8');

  const result = editPrefab(project.hostPath, [
    { op: 'ensure-meta', path: scriptPath },
  ], { projectRoot: project.root });

  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(scriptPath + '.meta'), true);
  assert.equal(fs.readFileSync(project.hostPath, 'utf8'), originalPrefab);
});

test('ensure-meta: dry-run 预告的 UUID 与 apply 完全一致', () => {
  const project = makeProject('meta-replayable', false);
  const scriptPath = path.join(project.assets, 'Replayable.ts');
  const metaPath = scriptPath + '.meta';
  fs.writeFileSync(scriptPath, "export class Replayable {}\n", 'utf8');

  const dry = editPrefab(project.hostPath, [
    { op: 'ensure-meta', path: scriptPath },
  ], { projectRoot: project.root, dryRun: true });
  assert.equal(fs.existsSync(metaPath), false);
  assert.equal(dry.externalChanges.length, 1);
  assert.equal(dry.externalChanges[0].action, 'create-meta');
  const plannedUuid = dry.externalChanges[0].meta.uuid;

  const applied = editPrefab(project.hostPath, [
    { op: 'ensure-meta', path: scriptPath },
  ], { projectRoot: project.root });
  assert.equal(applied.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).uuid, plannedUuid);
});

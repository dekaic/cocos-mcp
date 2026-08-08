'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parsePrefab } = require('../../src/parse.js');
const {
  makeCompPrefabInfo,
  makeLabel,
  makeNode,
  makePrefabInfo,
  makePrefabRoot,
  makeSprite,
  makeUITransform,
  ref,
  vec3,
} = require('../../src/primitives.js');

const NESTED_UUID = '11111111-2222-4333-8444-555555555555';
const COMPONENT_UUID = '5f4d2de3-a7dc-4d47-a41f-f27a12549b20';
const NESTED_ROOT_FILE_ID = 'fixture-inner-root-file-id';

const NAMES = Object.freeze({
  root: 'FixtureRoot',
  plain: 'PlainNode',
  label: 'LabelNode',
  sprite: 'SpriteNode',
  componentHost: 'ComponentHost',
  nested: 'NestedAlias',
});

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function makeNestedPrefab() {
  return [
    makePrefabRoot({ name: 'InnerFixture', rootId: 1 }),
    makeNode({
      name: 'InnerRoot',
      parentId: null,
      childIds: [3],
      prefabId: 2,
    }),
    makePrefabInfo({ rootId: 1, fileId: NESTED_ROOT_FILE_ID }),
    makeNode({
      name: 'InnerChild',
      parentId: 1,
      prefabId: 4,
    }),
    makePrefabInfo({ rootId: 1, fileId: 'fixture-inner-child-file-id' }),
  ];
}

function makeHostPrefab() {
  const stub = makeNode({
    name: '__serialized_stub_name_is_omitted__',
    parentId: 1,
    prefabId: 18,
  });
  delete stub._name;

  return [
    makePrefabRoot({ name: NAMES.root, rootId: 1 }), // 0
    makeNode({ // 1
      name: NAMES.root,
      parentId: null,
      childIds: [3, 5, 9, 13, 17],
      prefabId: 2,
    }),
    makePrefabInfo({ // 2
      rootId: 1,
      fileId: 'fixture-host-root-file-id',
      nestedPrefabInstanceRoots: [17],
    }),
    makeNode({ // 3
      name: NAMES.plain,
      pos: [-10, 20, 0],
      parentId: 1,
      prefabId: 4,
    }),
    makePrefabInfo({ rootId: 1, fileId: 'fixture-plain-node-file-id' }), // 4
    makeNode({ // 5
      name: NAMES.label,
      parentId: 1,
      componentIds: [7],
      prefabId: 6,
    }),
    makePrefabInfo({ rootId: 1, fileId: 'fixture-label-node-file-id' }), // 6
    makeLabel({ // 7
      nodeId: 5,
      string: 'Start',
      prefabInfoId: 8,
    }),
    makeCompPrefabInfo('fixture-label-component-file-id'), // 8
    makeNode({ // 9
      name: NAMES.sprite,
      parentId: 1,
      componentIds: [11],
      prefabId: 10,
    }),
    makePrefabInfo({ rootId: 1, fileId: 'fixture-sprite-node-file-id' }), // 10
    makeSprite({ // 11
      nodeId: 9,
      spriteFrameUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@f9941',
      prefabInfoId: 12,
    }),
    makeCompPrefabInfo('fixture-sprite-component-file-id'), // 12
    makeNode({ // 13
      name: NAMES.componentHost,
      parentId: 1,
      componentIds: [15],
      prefabId: 14,
    }),
    makePrefabInfo({ rootId: 1, fileId: 'fixture-component-host-file-id' }), // 14
    makeUITransform({ // 15
      nodeId: 13,
      width: 240,
      height: 80,
      prefabInfoId: 16,
    }),
    makeCompPrefabInfo('fixture-ui-transform-file-id'), // 16
    stub, // 17
    { // 18
      __type__: 'cc.PrefabInfo',
      root: ref(17),
      asset: {
        __uuid__: NESTED_UUID,
        __expectedType__: 'cc.Prefab',
      },
      fileId: 'fixture-outer-stub-file-id',
      instance: ref(19),
      targetOverrides: null,
      nestedPrefabInstanceRoots: null,
    },
    { // 19
      __type__: 'cc.PrefabInstance',
      fileId: 'fixture-prefab-instance-file-id',
      prefabRootNode: ref(1),
      mountedChildren: [],
      mountedComponents: [],
      propertyOverrides: [ref(20), ref(22)],
      removedComponents: [],
    },
    { // 20
      __type__: 'CCPropertyOverrideInfo',
      targetInfo: ref(21),
      propertyPath: ['_name'],
      value: NAMES.nested,
    },
    { __type__: 'cc.TargetInfo', localID: [NESTED_ROOT_FILE_ID] }, // 21
    { // 22
      __type__: 'CCPropertyOverrideInfo',
      targetInfo: ref(23),
      propertyPath: ['_lpos'],
      value: vec3(12, 34, 0),
    },
    { __type__: 'cc.TargetInfo', localID: [NESTED_ROOT_FILE_ID] }, // 23
  ];
}

function parseWithResolver(filePath, resolverStartPath) {
  const parsed = parsePrefab(filePath);
  parsed.resolverStartPath = resolverStartPath || filePath;
  return parsed;
}

function findNodeId(parsed, name) {
  const node = parsed.findNodeByName(name);
  if (!node) throw new Error(`fixture: 找不到节点 "${name}"`);
  const id = parsed.elements.indexOf(node);
  if (id < 0) throw new Error(`fixture: 节点 "${name}" 没有有效 __id__`);
  return id;
}

function createFixtureProject(testContext, tag) {
  const safeTag = String(tag || 'case').replace(/[^a-zA-Z0-9_-]/g, '-');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cocos-mcp-fixture-${safeTag}-`));
  const assets = path.join(root, 'assets');
  const scripts = path.join(assets, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });

  writeJson(path.join(root, 'package.json'), {
    name: `cocos-mcp-fixture-${safeTag}`,
    version: '1.0.0',
  });

  const hostPath = path.join(assets, 'Fixture.prefab');
  const nestedPath = path.join(assets, 'Inner.prefab');
  writeJson(hostPath, makeHostPrefab());
  writeJson(hostPath + '.meta', { uuid: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb' });
  writeJson(nestedPath, makeNestedPrefab());
  writeJson(nestedPath + '.meta', { uuid: NESTED_UUID });

  const componentPath = path.join(scripts, 'FixtureComponent.ts');
  fs.writeFileSync(
    componentPath,
    "import { _decorator, Component } from 'cc';\n" +
      "const { ccclass } = _decorator;\n" +
      "@ccclass('FixtureComponent')\n" +
      'export class FixtureComponent extends Component {}\n',
    'utf8'
  );
  writeJson(componentPath + '.meta', { uuid: COMPONENT_UUID });

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    fs.rmSync(root, { recursive: true, force: true });
  };
  if (testContext && typeof testContext.after === 'function') {
    testContext.after(cleanup);
  }

  return {
    root,
    assets,
    hostPath,
    nestedPath,
    componentPath,
    componentUuid: COMPONENT_UUID,
    nestedUuid: NESTED_UUID,
    nestedRootFileId: NESTED_ROOT_FILE_ID,
    names: NAMES,
    cleanup,
  };
}

module.exports = {
  COMPONENT_UUID,
  NAMES,
  NESTED_ROOT_FILE_ID,
  NESTED_UUID,
  createFixtureProject,
  findNodeId,
  makeHostPrefab,
  makeNestedPrefab,
  parseWithResolver,
  writeJson,
};

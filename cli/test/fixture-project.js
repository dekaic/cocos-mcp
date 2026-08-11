'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  makeCompPrefabInfo,
  makeLabel,
  makeNode,
  makePrefabInfo,
  makePrefabRoot,
  makeSprite,
  makeUITransform,
} = require('../src/primitives.js');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-cli-fixture-'));
const assetsDir = path.join(projectRoot, 'assets');
const scriptsDir = path.join(assetsDir, 'scripts');
const fixturePath = path.join(assetsDir, 'HomeUI.prefab');
const nestedPath = path.join(assetsDir, 'NestedEntry.prefab');

const NESTED_UUID = '11111111-2222-4333-8444-555555555555';
const NESTED_ROOT_FILE_ID = 'nestedRootFileId0001';
const NESTED_CHILD_FILE_ID = 'nestedChildFileId001';
const TASK_BTN_UUID = '5f4d2de3-a7dc-4d47-a41f-f27a12549b20';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function buildHomeUiFixture() {
  const elements = [];
  elements[0] = makePrefabRoot({ name: 'HomeUI', rootId: 1 });
  elements[1] = makeNode({
    name: 'HomeUI',
    childIds: [2, 3, 4, 5, 6, 10],
    prefabId: 13,
  });
  elements[2] = makeNode({ name: 'touchArea', parentId: 1, prefabId: 14 });
  elements[3] = makeNode({ name: 'left', parentId: 1, pos: [-243, 0, 0], prefabId: 15 });
  elements[4] = makeNode({ name: 'n5', parentId: 1, componentIds: [7], prefabId: 16 });
  elements[5] = makeNode({ name: 'n7', parentId: 1, componentIds: [8], prefabId: 17 });
  elements[6] = makeNode({ name: 'btnMerge', parentId: 1, componentIds: [9], prefabId: 18 });
  elements[7] = makeSprite({
    nodeId: 4,
    spriteFrameUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@f9941',
    prefabInfoId: 19,
  });
  elements[8] = makeLabel({ nodeId: 5, string: 'Start', prefabInfoId: 20 });
  elements[9] = makeUITransform({ nodeId: 6, width: 160, height: 60, prefabInfoId: 21 });

  elements[10] = {
    __type__: 'cc.Node',
    _objFlags: 0,
    __editorExtras__: {},
    _parent: { __id__: 1 },
    _children: [],
    _active: true,
    _components: [],
    _prefab: { __id__: 11 },
    _id: '',
  };
  elements[11] = {
    __type__: 'cc.PrefabInfo',
    root: { __id__: 10 },
    asset: { __uuid__: NESTED_UUID, __expectedType__: 'cc.Prefab' },
    fileId: 'stubOuterFileId00001',
    instance: { __id__: 12 },
    targetOverrides: null,
  };
  elements[12] = {
    __type__: 'cc.PrefabInstance',
    fileId: 'prefabInstanceFile01',
    prefabRootNode: { __id__: 1 },
    mountedChildren: [],
    mountedComponents: [],
    propertyOverrides: [{ __id__: 23 }, { __id__: 25 }, { __id__: 27 }],
    removedComponents: [],
  };

  elements[13] = makePrefabInfo({
    rootId: 1,
    fileId: 'homeRootFileId000001',
    nestedPrefabInstanceRoots: [10],
  });
  elements[14] = makePrefabInfo({ rootId: 1, fileId: 'touchAreaFileId0001' });
  elements[15] = makePrefabInfo({ rootId: 1, fileId: 'leftNodeFileId00001' });
  elements[16] = makePrefabInfo({ rootId: 1, fileId: 'spriteNodeFileId001' });
  elements[17] = makePrefabInfo({ rootId: 1, fileId: 'labelNodeFileId0001' });
  elements[18] = makePrefabInfo({ rootId: 1, fileId: 'mergeNodeFileId0001' });
  elements[19] = makeCompPrefabInfo('spriteCompFileId0001');
  elements[20] = makeCompPrefabInfo('labelCompFileId00001');
  elements[21] = makeCompPrefabInfo('uiCompFileId0000001');

  elements[22] = { __type__: 'cc.TargetInfo', localID: [NESTED_ROOT_FILE_ID] };
  elements[23] = {
    __type__: 'CCPropertyOverrideInfo',
    targetInfo: { __id__: 22 },
    propertyPath: ['_name'],
    value: 'taskEntry',
  };
  elements[24] = { __type__: 'cc.TargetInfo', localID: [NESTED_ROOT_FILE_ID] };
  elements[25] = {
    __type__: 'CCPropertyOverrideInfo',
    targetInfo: { __id__: 24 },
    propertyPath: ['_lpos'],
    value: { __type__: 'cc.Vec3', x: -272, y: 53, z: 0 },
  };
  elements[26] = { __type__: 'cc.TargetInfo', localID: [NESTED_ROOT_FILE_ID] };
  elements[27] = {
    __type__: 'CCPropertyOverrideInfo',
    targetInfo: { __id__: 26 },
    propertyPath: ['_active'],
    value: true,
  };
  return elements;
}

function buildNestedFixture() {
  return [
    makePrefabRoot({ name: 'NestedEntry', rootId: 1 }),
    makeNode({ name: 'NestedEntry', childIds: [2], prefabId: 3 }),
    makeNode({ name: 'MovableChild', parentId: 1, pos: [1, 2, 3], prefabId: 4 }),
    makePrefabInfo({ rootId: 1, fileId: NESTED_ROOT_FILE_ID }),
    makePrefabInfo({ rootId: 1, fileId: NESTED_CHILD_FILE_ID }),
  ];
}

fs.mkdirSync(scriptsDir, { recursive: true });
writeJson(path.join(projectRoot, 'package.json'), { name: 'cocos-mcp-cli-fixture', private: true });
writeJson(fixturePath, buildHomeUiFixture());
writeJson(nestedPath, buildNestedFixture());
writeJson(nestedPath + '.meta', { uuid: NESTED_UUID });
fs.writeFileSync(
  path.join(scriptsDir, 'TaskBtn.ts'),
  "@ccclass('TaskBtn')\nexport class TaskBtn {}\n",
  'utf8'
);
writeJson(path.join(scriptsDir, 'TaskBtn.ts.meta'), { uuid: TASK_BTN_UUID });

process.once('exit', function () {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
});

module.exports = {
  fixturePath,
  nestedChildFileId: NESTED_CHILD_FILE_ID,
  projectRoot,
  taskBtnUuid: TASK_BTN_UUID,
};

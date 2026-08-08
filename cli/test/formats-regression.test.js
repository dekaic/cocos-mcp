'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BIN = path.resolve(__dirname, '../bin/cocos-mcp-cli.js');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: __dirname,
  });
}

test('create-prefab: 同名跨路径 ID 隔离，同路径可重放', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-create-path-seed-'));
  const projectA = path.join(tmp, 'project-a');
  const projectB = path.join(tmp, 'project-b');
  const outA = path.join(projectA, 'assets', 'ui', 'Shared.prefab');
  const outB = path.join(projectA, 'assets', 'other', 'Shared.prefab');
  const copiedProjectOut = path.join(projectB, 'assets', 'ui', 'Shared.prefab');

  try {
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    }

    const firstA = run(['create-prefab', outA, '--name', 'Shared']);
    const firstB = run(['create-prefab', outB, '--name', 'Shared']);
    const copiedProject = run(['create-prefab', copiedProjectOut, '--name', 'Shared']);
    assert.equal(firstA.status, 0, firstA.stderr);
    assert.equal(firstB.status, 0, firstB.stderr);
    assert.equal(copiedProject.status, 0, copiedProject.stderr);

    const aPrefabFirst = fs.readFileSync(outA, 'utf8');
    const aMetaFirst = fs.readFileSync(outA + '.meta', 'utf8');
    const bData = JSON.parse(fs.readFileSync(outB, 'utf8'));
    const bMeta = JSON.parse(fs.readFileSync(outB + '.meta', 'utf8'));
    const aData = JSON.parse(aPrefabFirst);
    const aMeta = JSON.parse(aMetaFirst);
    const fileIds = (data) => data
      .filter((el) => el && typeof el.fileId === 'string')
      .map((el) => el.fileId);

    assert.notEqual(aMeta.uuid, bMeta.uuid, '不同输出路径的同名 prefab UUID 应不同');
    const idsA = fileIds(aData);
    const idsB = fileIds(bData);
    assert.ok(idsA.length > 0 && idsB.length > 0);
    for (const id of idsA) {
      assert.ok(!idsB.includes(id), `跨路径 fileId 不应重复: ${id}`);
    }
    assert.equal(
      fs.readFileSync(copiedProjectOut, 'utf8'),
      aPrefabFirst,
      '不同项目根下相同 assets 相对路径应生成相同 prefab 字节'
    );
    assert.equal(
      fs.readFileSync(copiedProjectOut + '.meta', 'utf8'),
      aMetaFirst,
      '不同项目根下相同 assets 相对路径应生成相同 meta 字节'
    );

    const replayA = run(['create-prefab', outA, '--name', 'Shared']);
    assert.equal(replayA.status, 0, replayA.stderr);
    assert.equal(fs.readFileSync(outA, 'utf8'), aPrefabFirst, '同路径重放的 prefab 应完全稳定');
    assert.equal(fs.readFileSync(outA + '.meta', 'utf8'), aMetaFirst, '同路径重放的 meta 应完全稳定');

    const prefabQuery = run(['query', outA, '--selector', 'tree']);
    assert.equal(prefabQuery.status, 0, prefabQuery.stderr);
    assert.equal(JSON.parse(prefabQuery.stdout).name, 'Shared', '普通 Prefab 默认解析路径应保持兼容');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('anim query/batch: 标准 cc.AnimationClip 不需要 Prefab 头', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-standard-anim-'));
  const animPath = path.join(tmp, 'Real.anim');
  const opsPath = path.join(tmp, 'ops.json');
  const {
    makeAdditiveSettings,
    makeAnimationClip,
    hashString,
  } = require('../src/anim-primitives.js');

  try {
    const objects = [null, makeAdditiveSettings()];
    objects[0] = makeAnimationClip({
      name: 'Real',
      sample: 30,
      duration: 1,
      speed: 1,
      hash: hashString('Real'),
      trackIndices: [],
      additiveIdx: 1,
    });
    fs.writeFileSync(animPath, JSON.stringify(objects, null, 2) + '\n');
    assert.equal(objects[0].__type__, 'cc.AnimationClip');
    assert.ok(!objects.some((el) => el && el.__type__ === 'cc.Prefab'));

    const treeResult = run(['anim', 'query', animPath, '--selector', 'tree']);
    assert.equal(treeResult.status, 0, treeResult.stderr);
    const tree = JSON.parse(treeResult.stdout);
    assert.equal(tree.name, 'Real');
    assert.equal(tree.type, 'cc.AnimationClip');

    const nodeResult = run(['anim', 'query', animPath, '--selector', 'node', '--name', 'Real']);
    assert.equal(nodeResult.status, 0, nodeResult.stderr);
    assert.equal(JSON.parse(nodeResult.stdout).type, 'cc.AnimationClip');

    const fieldResult = run([
      'anim', 'query', animPath,
      '--selector', 'field', '--name', 'Real', '--comp', 'cc.AnimationClip', '--field', 'speed',
    ]);
    assert.equal(fieldResult.status, 0, fieldResult.stderr);
    assert.equal(JSON.parse(fieldResult.stdout), 1);

    fs.writeFileSync(opsPath, JSON.stringify([
      {
        op: 'set-component-field',
        node: 'Real',
        componentType: 'cc.AnimationClip',
        property: 'speed',
        value: 2,
      },
      {
        op: 'set-component-field',
        node: { id: 0 },
        componentType: 'cc.AnimationClip',
        property: 'wrapMode',
        value: 2,
      },
    ]));
    const dryRunResult = run(['anim', 'batch', animPath, opsPath, '--dry-run']);
    assert.equal(dryRunResult.status, 0, dryRunResult.stderr);
    assert.equal(JSON.parse(fs.readFileSync(animPath, 'utf8'))[0].speed, 1, 'dry-run 不应落盘');
    assert.ok(JSON.parse(dryRunResult.stdout).diff.length > 0);

    const batchResult = run(['anim', 'batch', animPath, opsPath]);
    assert.equal(batchResult.status, 0, batchResult.stderr);
    const editedClip = JSON.parse(fs.readFileSync(animPath, 'utf8'))[0];
    assert.equal(editedClip.speed, 2);
    assert.equal(editedClip.wrapMode, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('anim query: 工程裁剪 animation 模块时给出明确运行时诊断', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-anim-module-'));
  const project = path.join(tmp, 'project');
  const assets = path.join(project, 'assets');
  const settings = path.join(project, 'settings/v2/packages');
  const animPath = path.join(assets, 'Move.anim');
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"anim-module"}\n');
    fs.writeFileSync(path.join(settings, 'engine.json'), JSON.stringify({
      modules: {
        globalConfigKey: 'defaultConfig',
        configs: {
          defaultConfig: {
            cache: { animation: { _value: false } },
            includeModules: ['base', '2d'],
          },
        },
      },
    }));
    fs.writeFileSync(animPath, JSON.stringify([{
      __type__: 'cc.AnimationClip', _name: 'Move', _tracks: [], _events: [],
      _embeddedPlayers: [], _auxiliaryCurveEntries: [],
    }]));

    const result = run(['anim', 'query', animPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /animation.*disabled.*Error 5302.*Creator.*feature cropping/i);

    const configPath = path.join(settings, 'engine.json');
    const enabled = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    enabled.modules.configs.defaultConfig.cache.animation._value = true;
    enabled.modules.configs.defaultConfig.includeModules.push('animation');
    fs.writeFileSync(configPath, JSON.stringify(enabled));
    const enabledResult = run(['anim', 'query', animPath]);
    assert.equal(enabledResult.status, 0, enabledResult.stderr);
    assert.doesNotMatch(enabledResult.stderr, /Error 5302/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extract-prefab: 仅提取目标子树并迁移双端在内的 targetOverrides', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-extract-subtree-'));
  const src = path.join(tmp, 'Host.prefab');
  const out = path.join(tmp, 'Extracted.prefab');
  const { makePrefabRoot, makeNode, makePrefabInfo } = require('../src/primitives.js');

  try {
    const source = [
      makePrefabRoot({ name: 'HostRoot', rootId: 1 }),
      makeNode({ name: 'HostRoot', childIds: [3, 5], componentIds: [12], prefabId: 2 }),
      makePrefabInfo({
        rootId: 1,
        fileId: 'host-root-file-id',
        assetId: 0,
        nestedPrefabInstanceRoots: [7],
      }),
      makeNode({ name: 'Target', parentId: 1, childIds: [7], componentIds: [10], prefabId: 4 }),
      makePrefabInfo({ rootId: 1, fileId: 'target-file-id', assetId: 0 }),
      makeNode({ name: 'Sibling', parentId: 1, prefabId: 6 }),
      makePrefabInfo({ rootId: 1, fileId: 'sibling-file-id', assetId: 0 }),
      {
        __type__: 'cc.Node',
        _objFlags: 0,
        _parent: { __id__: 3 },
        _prefab: { __id__: 8 },
        __editorExtras__: {},
      },
      {
        __type__: 'cc.PrefabInfo',
        root: { __id__: 7 },
        asset: {
          __uuid__: '11111111-2222-4333-8444-555555555555',
          __expectedType__: 'cc.Prefab',
        },
        fileId: 'nested-stub-file-id',
        instance: { __id__: 9 },
        targetOverrides: null,
      },
      {
        __type__: 'cc.PrefabInstance',
        fileId: 'nested-instance-file-id',
        prefabRootNode: { __id__: 1 },
        mountedChildren: [],
        mountedComponents: [],
        propertyOverrides: [],
        removedComponents: [],
      },
      {
        __type__: 'InsideSourceComp',
        node: { __id__: 3 },
        __prefab: { __id__: 11 },
        _insideRef: null,
        _outsideTargetRef: null,
      },
      { __type__: 'cc.CompPrefabInfo', fileId: 'inside-source-comp-file-id' },
      {
        __type__: 'OutsideSourceComp',
        node: { __id__: 1 },
        __prefab: { __id__: 13 },
        _insideTargetRef: null,
      },
      { __type__: 'cc.CompPrefabInfo', fileId: 'outside-source-comp-file-id' },
      { __type__: 'cc.TargetInfo', localID: ['inside-target-local-id'] },
      {
        __type__: 'cc.TargetOverrideInfo',
        source: { __id__: 10 },
        sourceInfo: null,
        propertyPath: ['_insideRef'],
        target: { __id__: 7 },
        targetInfo: { __id__: 14 },
      },
      { __type__: 'cc.TargetInfo', localID: ['outside-target-local-id'] },
      {
        __type__: 'cc.TargetOverrideInfo',
        source: { __id__: 10 },
        sourceInfo: null,
        propertyPath: ['_outsideTargetRef'],
        target: { __id__: 5 },
        targetInfo: { __id__: 16 },
      },
      { __type__: 'cc.TargetInfo', localID: ['outside-source-local-id'] },
      {
        __type__: 'cc.TargetOverrideInfo',
        source: { __id__: 12 },
        sourceInfo: null,
        propertyPath: ['_insideTargetRef'],
        target: { __id__: 7 },
        targetInfo: { __id__: 18 },
      },
    ];
    source[2].targetOverrides = [{ __id__: 15 }, { __id__: 17 }, { __id__: 19 }];
    fs.writeFileSync(src, JSON.stringify(source, null, 2) + '\n');

    const result = run(['extract-prefab', src, out, '--node', 'Target', '--name', 'Extracted']);
    assert.equal(result.status, 0, result.stderr);

    const extracted = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(extracted.filter((el) => el && el.__type__ === 'cc.Prefab').length, 1);
    const nodes = extracted.filter((el) => el && el.__type__ === 'cc.Node');
    assert.equal(nodes.length, 2, '应保留目标根及其嵌套 prefab stub');
    assert.equal(nodes[0]._name, 'Extracted');
    assert.equal(extracted.length, 10, '输出只应包含新头和目标子树的引用闭包');
    assert.equal(extracted[0].data.__id__, 1);
    assert.equal(extracted[1]._parent, null);
    assert.equal(extracted[2].__type__, 'cc.PrefabInfo');
    assert.deepEqual(extracted[2].root, { __id__: 1 });
    assert.deepEqual(extracted[2].asset, { __id__: 0 });
    assert.deepEqual(extracted[2].nestedPrefabInstanceRoots, [{ __id__: 3 }]);
    assert.deepEqual(extracted[2].targetOverrides, [{ __id__: 9 }]);
    assert.equal(extracted[4].__type__, 'cc.PrefabInfo');
    assert.deepEqual(extracted[4].root, { __id__: 3 });
    assert.equal(extracted[4].asset.__uuid__, '11111111-2222-4333-8444-555555555555');
    assert.equal(extracted[5].__type__, 'cc.PrefabInstance');
    assert.deepEqual(extracted[5].prefabRootNode, { __id__: 1 });
    assert.equal(extracted[6].__type__, 'InsideSourceComp');
    assert.deepEqual(extracted[6].node, { __id__: 1 });
    assert.equal(extracted[6]._insideRef, null, '跨 nested 组件引用由 targetOverride 恢复');
    assert.equal(extracted[8].__type__, 'cc.TargetInfo');
    assert.deepEqual(extracted[8].localID, ['inside-target-local-id']);
    assert.equal(extracted[9].__type__, 'cc.TargetOverrideInfo');
    assert.deepEqual(extracted[9].source, { __id__: 6 });
    assert.deepEqual(extracted[9].target, { __id__: 3 });
    assert.deepEqual(extracted[9].targetInfo, { __id__: 8 });
    assert.deepEqual(extracted[9].propertyPath, ['_insideRef']);
    assert.equal(
      extracted.filter((el) => el && el.__type__ === 'cc.TargetOverrideInfo').length,
      1,
      '任一端在子树外的 targetOverride 应丢弃'
    );
    assert.doesNotMatch(
      JSON.stringify(extracted),
      /HostRoot|Sibling|OutsideSourceComp|outside-target-local-id|outside-source-local-id/
    );

    const firstMeta = fs.readFileSync(out + '.meta', 'utf8');
    const relativeOut = path.relative(__dirname, out);
    const replay = run(['extract-prefab', src, relativeOut, '--node', 'Target', '--name', 'Extracted']);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(
      fs.readFileSync(out + '.meta', 'utf8'),
      firstMeta,
      '同一输出文件用绝对/相对路径重放时 UUID 应稳定'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extract-prefab: 拒绝直接提取 nested prefab stub 根，避免生成空 prefab', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-extract-stub-'));
  const project = path.join(tmp, 'project');
  const assets = path.join(project, 'assets');
  const inner = path.join(assets, 'Inner.prefab');
  const host = path.join(assets, 'Host.prefab');
  const out = path.join(assets, 'Out.prefab');
  const { makePrefabRoot, makeNode, makePrefabInfo } = require('../src/primitives.js');
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{"name":"extract-stub"}\n');
    fs.writeFileSync(inner, JSON.stringify([
      makePrefabRoot({ name: 'InnerRoot', rootId: 1 }),
      makeNode({ name: 'InnerRoot', parentId: null, prefabId: 2 }),
      makePrefabInfo({ rootId: 1, fileId: 'inner-root-file-id' }),
    ], null, 2));
    fs.writeFileSync(inner + '.meta', '{"uuid":"11111111-2222-4333-8444-555555555555"}\n');
    fs.writeFileSync(host, JSON.stringify([
      makePrefabRoot({ name: 'HostRoot', rootId: 1 }),
      makeNode({ name: 'HostRoot', parentId: null, childIds: [3], prefabId: 2 }),
      makePrefabInfo({ rootId: 1, fileId: 'host-root-file-id', nestedPrefabInstanceRoots: [3] }),
      { __type__: 'cc.Node', _objFlags: 0, __editorExtras__: {}, _parent: { __id__: 1 }, _prefab: { __id__: 4 } },
      {
        __type__: 'cc.PrefabInfo', root: { __id__: 3 },
        asset: { __uuid__: '11111111-2222-4333-8444-555555555555', __expectedType__: 'cc.Prefab' },
        fileId: 'stub-file-id', instance: { __id__: 5 }, targetOverrides: null,
      },
      {
        __type__: 'cc.PrefabInstance', fileId: 'instance-file-id', prefabRootNode: { __id__: 1 },
        mountedChildren: [], mountedComponents: [], propertyOverrides: [{ __id__: 7 }], removedComponents: [],
      },
      { __type__: 'cc.TargetInfo', localID: ['inner-root-file-id'] },
      {
        __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: 6 },
        propertyPath: ['_name'], value: 'InnerAlias',
      },
    ], null, 2));

    const result = run(['extract-prefab', host, out, '--node', 'InnerAlias']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nested prefab stub.*source prefab/i);
    assert.equal(fs.existsSync(out), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('query --help 显示子命令帮助，不误报缺 prefab', () => {
  const result = run(['query', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /query <prefab>/i);
  assert.doesNotMatch(result.stderr, /必须提供/);
});

test('query field/find 接受 @ccclass 名并解析为压缩 classId', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-query-classname-'));
  const assets = path.join(tmp, 'assets');
  const scripts = path.join(assets, 'scripts');
  const prefab = path.join(assets, 'Custom.prefab');
  const classUuid = '5a154a84-89a1-509a-8949-96edd6fb74a2';
  const classId = require('../src/id.js').compressUuid(classUuid);
  const { makePrefabRoot, makeNode, makePrefabInfo } = require('../src/primitives.js');
  try {
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"query-classname"}\n');
    fs.writeFileSync(path.join(scripts, 'MyComp.ts'), "@ccclass('MyComp')\nexport class MyComp {}\n");
    fs.writeFileSync(path.join(scripts, 'MyComp.ts.meta'), JSON.stringify({ uuid: classUuid }));
    fs.writeFileSync(prefab, JSON.stringify([
      makePrefabRoot({ name: 'Root', rootId: 1 }),
      makeNode({ name: 'Root', parentId: null, componentIds: [3], prefabId: 2 }),
      makePrefabInfo({ rootId: 1, fileId: 'root-file-id' }),
      { __type__: classId, node: { __id__: 1 }, score: 42 },
    ], null, 2));

    const field = run(['query', prefab, '--selector', 'field', '--name', 'Root', '--comp', 'MyComp', '--field', 'score']);
    assert.equal(field.status, 0, field.stderr);
    assert.equal(JSON.parse(field.stdout), 42);
    const found = run(['query', prefab, '--selector', 'find', '--type', 'MyComp']);
    assert.equal(found.status, 0, found.stderr);
    assert.deepEqual(JSON.parse(found.stdout), [3]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

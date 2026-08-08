// ============================================================
// cli/extract-cmd.js — extract-prefab 子命令
//
// 用法：
//   cocos-mcp-cli extract-prefab <src-prefab> <out-prefab>
//     --node <selector> [--name <new-name>] [--dry-run]
//
// 把 src-prefab 中某个子节点连同其整棵子树（含组件 / PrefabInfo /
// 嵌套 PrefabInstance / propertyOverrides / TargetInfo / mountedComponents
// 等所有 __id__ 引用闭包）提取出来，构造一个独立的新 prefab + .meta。
//
// 跟 batch op clone-node 的区别：
//   - clone-node 在同 prefab 内复制 + 挂到 parent
//   - extract-prefab 写出到新 .prefab 文件（含 cc.Prefab 头），脱离源文件
//
// 典型场景：把 HomeBottom 上的 btnTask 子树提取成独立的 task BottomEntry.prefab。
//
// selector 接受 batch 同款三种形式：
//   "btnTask"
//   { "id": 13 }
//   { "path": "btnTask" }
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { deterministicUUID } = require('../id.js');
const { parsePrefab } = require('../parse.js');
const { resolveNode, findRootPrefabInfo, isStub } = require('../editor/helpers.js');
const { syncNestedRoots } = require('../editor/id-utils.js');
const { normalizeOutputSeedPath } = require('./output-seed.js');

function die(msg) {
  process.stderr.write('Error: ' + msg + '\n');
  process.exit(1);
}

function parseSelector(raw) {
  // 支持 --node btnTask 或 --node '{"id":13}'
  const t = raw.trim();
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch (e) {
      die(`--node JSON 解析失败: ${t} (${e.message})`);
    }
  }
  return t;
}

function cmdExtractPrefab(argv) {
  let srcPath = null;
  let outPath = null;
  let nodeSelector = null;
  let newName = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--node') {
      nodeSelector = parseSelector(argv[++i] ?? '');
      if (!nodeSelector) die('--node 需要一个值');
    } else if (arg === '--name') {
      newName = argv[++i];
      if (!newName) die('--name 需要一个值');
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('--')) {
      if (srcPath === null) srcPath = arg;
      else if (outPath === null) outPath = arg;
      else die('多余的位置参数: ' + arg);
    } else {
      die(`未知参数 "${arg}"`);
    }
  }

  if (!srcPath || !outPath) {
    die('用法: extract-prefab <src-prefab> <out-prefab> --node <selector> [--name <new-name>] [--dry-run]');
  }
  if (nodeSelector === null) die('--node 是必需参数');

  const srcAbs = path.resolve(process.cwd(), srcPath);
  if (!fs.existsSync(srcAbs)) die(`源 prefab 不存在: ${srcPath}`);

  // 确保 .prefab 后缀
  if (!outPath.endsWith('.prefab')) outPath += '.prefab';
  if (!newName) newName = path.basename(outPath, '.prefab');

  // 1) 解析源 prefab
  const prefabData = parsePrefab(srcAbs);
  const { elements } = prefabData;
  const { node: srcNode, nodeId: srcNodeId } = resolveNode(prefabData, nodeSelector, 'extract-prefab');
  if (isStub(elements, srcNode)) {
    die(
      '不能直接提取 nested prefab stub；stub 只保存外部 prefab 引用，直接提取会生成空 prefab。' +
      ' 请从 source prefab 提取真实子树，或直接复制/引用该 nested prefab 资源。'
    );
  }

  // targetOverrides 挂在旧宿主根 PrefabInfo，不在被提取子节点的
  // 普通引用闭包内。先按节点所有权收集子树的节点/组件，
  // 后面只迁移 source 组件和 target 节点都在子树内的条目。
  const ownership = _collectSubtreeOwnership(elements, srcNodeId);

  // 2) BFS 闭包收集：从 srcNodeId 出发，把所有递归引用的 __id__ 拉进来
  const collected = new Set();
  _collectReferenceClosure(elements, [srcNodeId], collected);

  const retainedTargetOverrideIds = [];
  const sourceRootPrefabInfo = findRootPrefabInfo(elements, prefabData.rootId);
  if (sourceRootPrefabInfo && Array.isArray(sourceRootPrefabInfo.targetOverrides)) {
    for (const ref of sourceRootPrefabInfo.targetOverrides) {
      if (!ref || typeof ref.__id__ !== 'number') continue;
      const override = elements[ref.__id__];
      if (!override || override.__type__ !== 'cc.TargetOverrideInfo') continue;
      const sourceId = override.source && override.source.__id__;
      const targetId = override.target && override.target.__id__;
      if (!ownership.componentIds.has(sourceId) || !ownership.nodeIds.has(targetId)) continue;
      retainedTargetOverrideIds.push(ref.__id__);
    }
  }
  _collectReferenceClosure(elements, retainedTargetOverrideIds, collected);

  // 3) 重新编号：new[0] = 新 cc.Prefab 头部，new[1] = srcNode（root），其余按原 idx 升序。
  // 即使畸形引用把源头收进 collected，也绝不复制第二个 cc.Prefab 头。
  const oldToNew = new Map();
  const sortedOld = [
    srcNodeId,
    ...[...collected]
      .filter((i) => i !== srcNodeId && i !== 0 && elements[i] && elements[i].__type__ !== 'cc.Prefab')
      .sort((a, b) => a - b),
  ];
  const newData = [];

  // new[0]: 复制源 prefab 头部模板（只用 __type__ / data / optimizationPolicy / persistent 等基础字段）
  const srcHead = elements[0] && elements[0].__type__ === 'cc.Prefab' ? elements[0] : null;
  const newHead = {
    __type__: 'cc.Prefab',
    _name: '',
    _objFlags: 0,
    __editorExtras__: {},
    _native: '',
    data: { __id__: 1 },
    optimizationPolicy: srcHead && srcHead.optimizationPolicy !== undefined ? srcHead.optimizationPolicy : 0,
    persistent: srcHead && srcHead.persistent !== undefined ? srcHead.persistent : false,
  };
  newData.push(newHead);

  for (let i = 0; i < sortedOld.length; i++) {
    oldToNew.set(sortedOld[i], i + 1);
    newData.push(_deepClone(elements[sortedOld[i]]));
  }

  // 4) Remap __id__ 引用
  for (let i = 1; i < newData.length; i++) {
    _remapIds(newData[i], oldToNew);
  }

  // 5) 修正根节点：_parent=null, _name=newName
  const newRoot = newData[1];
  newRoot._parent = null;
  newRoot._name = newName;

  // 6) 修正所有本地节点的 PrefabInfo。源文件中这些对象的
  // root/asset 都指向旧宿主；提取后应统一指向新根和新头。
  // asset.__uuid__ 的嵌套 prefab PrefabInfo 仍保持外部资产引用。
  for (let i = 1; i < newData.length; i++) {
    const prefabInfo = newData[i];
    if (!prefabInfo) continue;
    if (prefabInfo.__type__ === 'cc.PrefabInfo') {
      if (prefabInfo.asset && Object.prototype.hasOwnProperty.call(prefabInfo.asset, '__id__')) {
        prefabInfo.root = { __id__: 1 };
        prefabInfo.asset = { __id__: 0 };
      }
    } else if (prefabInfo.__type__ === 'cc.PrefabInstance') {
      prefabInfo.prefabRootNode = { __id__: 1 };
    }
  }

  // 新根不再是旧宿主中的实例，清掉仅对旧宿主有意义的字段。
  if (newRoot._prefab && typeof newRoot._prefab.__id__ === 'number') {
    const rootPInfo = newData[newRoot._prefab.__id__];
    if (rootPInfo && rootPInfo.__type__ === 'cc.PrefabInfo') {
      rootPInfo.root = { __id__: 1 };
      rootPInfo.asset = { __id__: 0 };
      // instance/nested roots 在新宿主中重建；targetOverrides 只保留双端都在子树内的条目。
      if ('instance' in rootPInfo) rootPInfo.instance = null;
      rootPInfo.targetOverrides = retainedTargetOverrideIds.length > 0
        ? retainedTargetOverrideIds
          .map((oldId) => oldToNew.get(oldId))
          .filter((newId) => typeof newId === 'number')
          .map((newId) => ({ __id__: newId }))
        : null;
      if ('nestedPrefabInstanceRoots' in rootPInfo) rootPInfo.nestedPrefabInstanceRoots = null;
    }
  }
  syncNestedRoots(newData, 1);

  // 7) 生成 meta
  const outAbs = path.resolve(process.cwd(), outPath);
  const seed = `extract-prefab:${normalizeOutputSeedPath(outAbs)}:${newName}`;
  const newUuid = deterministicUUID(`${seed}:uuid`);
  const meta = {
    ver: '1.1.50',
    importer: 'prefab',
    imported: true,
    uuid: newUuid,
    files: ['.json'],
    subMetas: {},
    userData: { syncNodeName: newName },
  };

  if (dryRun) {
    process.stdout.write('=== PREFAB ===\n');
    process.stdout.write(JSON.stringify(newData, null, 2) + '\n');
    process.stdout.write('\n=== META ===\n');
    process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
    process.stdout.write(`\n=== STATS ===\ncollected ${collected.size} objects from source idx ${srcNodeId}\n`);
    return;
  }

  const dir = path.dirname(outAbs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(outAbs, JSON.stringify(newData, null, 2) + '\n', 'utf8');
  fs.writeFileSync(outAbs + '.meta', JSON.stringify(meta, null, 2) + '\n', 'utf8');

  process.stdout.write(`created: ${outPath} (${collected.size} objects)\n`);
  process.stdout.write(`created: ${outPath}.meta\n`);
}

// ── internals ────────────────────────────────────────────

// 跳过的字段：_parent 反向引用会把父链/兄弟子树拖进闭包，破坏"只提取子树"的语义
const SKIP_KEYS = new Set(['_parent']);

function _walkCollect(obj, out) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (const v of obj) _walkCollect(v, out);
    return;
  }
  if (typeof obj === 'object') {
    if (typeof obj.__id__ === 'number') {
      out.push(obj.__id__);
      return;
    }
    for (const k of Object.keys(obj)) {
      if (SKIP_KEYS.has(k)) continue;
      // 普通节点的 PrefabInfo.root / asset 是旧宿主的反向链接：
      // asset -> cc.Prefab.data 和 root 都会回到宿主根，进而把兄弟子树
      // 乃至第二个 cc.Prefab 头一起拉入输出。这两个引用会在
      // 重编号后统一指向新宿主，因此不属于子树闭包。
      if (
        obj.__type__ === 'cc.PrefabInfo' &&
        (k === 'root' || k === 'asset' || k === 'targetOverrides')
      ) continue;
      if (obj.__type__ === 'cc.PrefabInstance' && k === 'prefabRootNode') continue;
      _walkCollect(obj[k], out);
    }
  }
}

function _collectReferenceClosure(elements, seeds, collected) {
  const queue = seeds.slice();
  while (queue.length > 0) {
    const idx = queue.shift();
    if (!Number.isInteger(idx) || idx < 0 || idx >= elements.length || collected.has(idx)) continue;
    collected.add(idx);
    const refs = [];
    _walkCollect(elements[idx], refs);
    for (const ref of refs) {
      if (!collected.has(ref)) queue.push(ref);
    }
  }
}

function _collectSubtreeOwnership(elements, rootNodeId) {
  const nodeIds = new Set();
  const componentIds = new Set();

  function visit(nodeId) {
    if (nodeIds.has(nodeId)) return;
    const node = elements[nodeId];
    if (!node || node.__type__ !== 'cc.Node') return;
    nodeIds.add(nodeId);

    if (Array.isArray(node._components)) {
      for (const ref of node._components) {
        if (ref && typeof ref.__id__ === 'number') componentIds.add(ref.__id__);
      }
    }
    if (Array.isArray(node._children)) {
      for (const ref of node._children) {
        if (ref && typeof ref.__id__ === 'number') visit(ref.__id__);
      }
    }

    if (!node._prefab || typeof node._prefab.__id__ !== 'number') return;
    const prefabInfo = elements[node._prefab.__id__];
    if (!prefabInfo || !prefabInfo.instance || typeof prefabInfo.instance.__id__ !== 'number') return;
    const instance = elements[prefabInfo.instance.__id__];
    if (!instance || instance.__type__ !== 'cc.PrefabInstance') return;
    if (Array.isArray(instance.mountedComponents)) {
      for (const ref of instance.mountedComponents) {
        if (ref && typeof ref.__id__ === 'number') componentIds.add(ref.__id__);
      }
    }
    if (Array.isArray(instance.mountedChildren)) {
      for (const ref of instance.mountedChildren) {
        if (ref && typeof ref.__id__ === 'number') visit(ref.__id__);
      }
    }
  }

  visit(rootNodeId);
  return { nodeIds, componentIds };
}

function _deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(_deepClone);
  const out = {};
  for (const k of Object.keys(obj)) out[k] = _deepClone(obj[k]);
  return out;
}

function _remapIds(obj, map) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (const v of obj) _remapIds(v, map);
    return;
  }
  if (typeof obj === 'object') {
    if (typeof obj.__id__ === 'number') {
      const newId = map.get(obj.__id__);
      if (newId !== undefined) {
        obj.__id__ = newId;
      } else {
        // 引用集合外的 idx —— 闭包应该完整，理论不会发生
        obj.__id__ = null;
      }
      return;
    }
    for (const k of Object.keys(obj)) _remapIds(obj[k], map);
  }
}

module.exports = { cmdExtractPrefab };

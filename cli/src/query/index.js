// ============================================================
// query/index.js — 只读查询主入口
//
// queryPrefab(filePath, selector)
//   selector.type = 'tree'      → 节点树（默认；selector.withComps 展开组件字段）
//   selector.type = 'node'      → 单节点详情（同上 withComps）
//   selector.type = 'find'      → 列所有 __type__ 匹配的 id
//   selector.type = 'field'     → 单组件单字段值
//   selector.type = 'overrides' → 列 stub 节点 propertyOverrides + root targetOverrides
// ============================================================

'use strict';

const { parsePrefab } = require('../parse.js');
const { queryTree } = require('./tree.js');
const { queryNode } = require('./node.js');
const { queryFind } = require('./find.js');
const { queryField } = require('./field.js');
const { queryOverrides } = require('./overrides.js');
const { normalizeComponentType } = require('../editor/helpers.js');
const { hashContent } = require('../transaction.js');

function queryPrefab(filePath, selector, options) {
  const prefabData = parsePrefab(filePath, options);
  return queryParsedPrefab(prefabData, filePath, selector);
}

/**
 * 与 queryPrefab 相同，但 revision 直接取自本次解析使用的同一份原始字节，
 * 避免“查询后再读一次文件”产生结果与 expectedHash 不属于同一快照的竞态。
 */
function queryPrefabWithRevision(filePath, selector, options) {
  const prefabData = parsePrefab(filePath, options);
  return {
    result: queryParsedPrefab(prefabData, filePath, selector),
    revision: hashContent(prefabData.raw),
  };
}

function queryParsedPrefab(prefabData, filePath, selector) {
  // overrides 需要按 uuid 反查嵌套 prefab，必须知道 host path 用作 UuidResolver 起点
  prefabData.resolverStartPath = filePath;

  const type = selector && selector.type ? selector.type : 'tree';
  const opts = { withComps: !!(selector && selector.withComps) };

  if (type === 'tree') {
    return queryTree(prefabData, opts);
  }

  if (type === 'node') {
    const name = selector && selector.name;
    if (!name) throw new Error('queryPrefab: selector.type="node" 时必须提供 selector.name');
    return queryNode(prefabData, name, opts);
  }

  if (type === 'find') {
    let nodeType = selector && selector.nodeType;
    if (!nodeType) throw new Error('queryPrefab: selector.type="find" 时必须提供 selector.nodeType');
    nodeType = normalizeComponentType(nodeType, filePath);
    return queryFind(prefabData, nodeType);
  }

  if (type === 'field') {
    const fieldSelector = Object.assign({}, selector, {
      componentType: normalizeComponentType(selector && selector.componentType, filePath),
    });
    return queryField(prefabData, fieldSelector);
  }

  if (type === 'overrides') {
    return queryOverrides(prefabData, selector);
  }

  throw new Error(`queryPrefab: 未知 selector.type "${type}"，支持 tree / node / find / field / overrides`);
}

module.exports = { queryPrefab, queryPrefabWithRevision };

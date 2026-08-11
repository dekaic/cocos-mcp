// set-nested-node-field: 改 stub 展开后内部节点的字段
// op: { op, node, subNode, property, value }
//
// - node: 外层 prefab 的 stub 节点名或 {id}
// - subNode: 子 prefab 内节点名，或节点路径 / 多层 nested 路径数组
// - property: 节点字段名（如 '_lpos' / '_active'）；支持嵌套路径数组
// - value: 要写入的 raw JSON

'use strict';

const { isStub, resolveNode } = require('../helpers.js');
const { resolveLocalIdChain, setStubPropertyOverride } = require('../nested.js');

function execSetNestedNodeField(prefabData, op) {
  const { elements } = prefabData;
  const { node: nodeSelector, subNode, property, value } = op;

  const validSubNode =
    (typeof subNode === 'string' && subNode.length > 0) ||
    (Array.isArray(subNode) && subNode.length > 0 && subNode.every((s) => typeof s === 'string' && s.length > 0));
  if (!validSubNode) {
    throw new Error(`editPrefab [set-nested-node-field]: subNode 必须是非空字符串或非空字符串数组`);
  }
  if (!property || (typeof property !== 'string' && !Array.isArray(property))) {
    throw new Error(`editPrefab [set-nested-node-field]: property 必须是字符串或数组`);
  }
  if (value === undefined) {
    throw new Error(`editPrefab [set-nested-node-field]: value 不能是 undefined`);
  }

  const { node, nodeId } = resolveNode(prefabData, nodeSelector, 'set-nested-node-field');
  if (!isStub(elements, node)) {
    throw new Error(
      `editPrefab [set-nested-node-field]: 节点 "${node._name || nodeId}" 不是 stub 代理`
    );
  }

  const localIdChain = resolveLocalIdChain(
    prefabData.resolverStartPath, elements, nodeId, 'cc.Node', subNode
  );
  const propertyPath = Array.isArray(property) ? property : [property];
  setStubPropertyOverride(prefabData, nodeId, localIdChain, propertyPath, value);
  return nodeId;
}

module.exports = { execSetNestedNodeField };

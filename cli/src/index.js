'use strict';

// 统一入口：re-export 所有公开 API
const { parsePrefab } = require('./parse.js');
const { writePrefab } = require('./write.js');
const { editPrefab } = require('./editor/index.js');
const { queryPrefab } = require('./query/index.js');
const { setOverrideProperty, listOverrides } = require('./overrides.js');
const { deterministicUUID, deterministicFileId, createFileIdGenerator } = require('./id.js');
const primitives = require('./primitives.js');
const animPrimitives = require('./anim-primitives.js');
const {
  parseAnimationClip,
  queryAnimationClip,
  createAnimationClip,
} = require('./animation.js');

module.exports = {
  parsePrefab,
  writePrefab,
  editPrefab,
  queryPrefab,
  setOverrideProperty,
  listOverrides,
  deterministicUUID,
  deterministicFileId,
  createFileIdGenerator,
  parseAnimationClip,
  queryAnimationClip,
  createAnimationClip,
  ...primitives,
  // .anim 文件对象构建原语（AnimationClip / Track / Curve / Channel）。
  // 解析、查询和创建入口由 animation.js 单独提供，不套用 cc.Prefab 根校验。
  anim: animPrimitives,
};
